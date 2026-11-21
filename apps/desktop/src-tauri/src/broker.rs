use crate::process_guard::GuardedChild;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, watch, Mutex as AsyncMutex},
    time::{interval, timeout, Instant},
};

const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_PENDING: usize = 128;
const WRITE_LIMIT: Duration = Duration::from_secs(5);
const REQUEST_LIMIT: Duration = Duration::from_secs(30);
const PING: &str = "desktop-heartbeat";
const RESET: &str = "--assentor-reset-desktop-rpc--";

type Listener = Arc<Mutex<Option<Channel<Value>>>>;

struct Link {
    generation: u64,
    requests: mpsc::Sender<String>,
    listener: Listener,
    active: Arc<AtomicBool>,
    stop: watch::Sender<bool>,
    done: tauri::async_runtime::JoinHandle<()>,
}

pub struct Broker {
    inner: AsyncMutex<Inner>,
    resources: PathBuf,
    log: PathBuf,
}

struct Inner {
    generation: u64,
    project: PathBuf,
    link: Option<Link>,
    closing: bool,
}

impl Broker {
    pub fn new(project: PathBuf, resources: PathBuf, log: PathBuf) -> Self {
        Self {
            inner: AsyncMutex::new(Inner {
                generation: 0,
                project,
                link: None,
                closing: false,
            }),
            resources,
            log,
        }
    }

    pub async fn connect(&self, channel: Channel<Value>) -> Result<Value, String> {
        let mut inner = self.inner.lock().await;
        if inner.closing {
            return Err(String::from("Assentor is closing"));
        }
        inner.generation += 1;
        let generation = inner.generation;
        if let Some(link) = inner.link.as_mut() {
            if link.active.load(Ordering::Acquire) {
                if matches!(
                    timeout(Duration::from_secs(2), link.requests.send(RESET.into())).await,
                    Ok(Ok(()))
                ) {
                    if let Ok(mut listener) = link.listener.lock() {
                        *listener = Some(channel);
                        link.generation = generation;
                        return Ok(json!({"generation": generation, "writeGranted": true}));
                    }
                }
            }
        }
        if let Some(link) = inner.link.take() {
            stop(link).await;
        }
        let child = GuardedChild::start(&inner.project, &self.resources, true)
            .map_err(|error| format!("Could not launch the desktop engine: {error}"))?;
        let listener = Arc::new(Mutex::new(Some(channel)));
        let active = Arc::new(AtomicBool::new(true));
        let (requests, request_rx) = mpsc::channel(64);
        let (stop_tx, stop_rx) = watch::channel(false);
        let (ready, boot) = tokio::sync::oneshot::channel();
        let output = listener.clone();
        let status = active.clone();
        let log = self.log.clone();
        let done = tauri::async_runtime::spawn(async move {
            let result = run(child, request_rx, stop_rx, &output, ready).await;
            status.store(false, Ordering::Release);
            publish(&output, json!({"closed": true}));
            record(
                &log,
                if result.is_ok() {
                    "stopped"
                } else {
                    "connection_lost"
                },
            );
        });
        inner.link = Some(Link {
            generation,
            requests,
            listener,
            active,
            stop: stop_tx,
            done,
        });
        let result = timeout(Duration::from_secs(12), boot).await;
        match result {
            Ok(Ok(())) => {
                record(&self.log, "connected");
                Ok(json!({"generation": generation, "writeGranted": true}))
            }
            _ => {
                if let Some(link) = inner.link.take() {
                    stop(link).await;
                }
                Err(String::from(
                    "The bundled engine did not complete its version handshake",
                ))
            }
        }
    }

    pub async fn request(&self, generation: u64, frame: String) -> Result<(), String> {
        validate_request(&frame)?;
        let inner = self.inner.lock().await;
        let link = inner
            .link
            .as_ref()
            .filter(|link| link.generation == generation && link.active.load(Ordering::Acquire))
            .ok_or("Desktop engine disconnected")?;
        link.requests
            .try_send(frame)
            .map_err(|_| String::from("Desktop engine request queue is full or disconnected"))
    }

    pub async fn project(&self) -> PathBuf {
        self.inner.lock().await.project.clone()
    }

    pub async fn set_project(&self, project: PathBuf) {
        let mut inner = self.inner.lock().await;
        if inner.project != project {
            if let Some(link) = inner.link.take() {
                stop(link).await;
            }
            inner.project = project;
        }
    }

    pub async fn shutdown(&self) {
        let mut inner = self.inner.lock().await;
        inner.closing = true;
        if let Some(link) = inner.link.take() {
            stop(link).await;
        }
    }

    pub async fn reopen_after_failed_update(&self) {
        self.inner.lock().await.closing = false;
    }
}

async fn stop(link: Link) {
    let _ = link.stop.send(true);
    let _ = timeout(Duration::from_secs(11), link.done).await;
}

fn validate_request(frame: &str) -> Result<(), String> {
    if frame.len() > MAX_FRAME_BYTES || frame.contains(['\n', '\r']) {
        return Err(String::from("Invalid desktop RPC frame"));
    }
    let value: Value = serde_json::from_str(frame).map_err(|_| "Invalid desktop RPC JSON")?;
    let method = value["method"].as_str().unwrap_or_default();
    if value["jsonrpc"] != "2.0"
        || value["id"].as_u64().filter(|id| *id > 0).is_none()
        || method.is_empty()
        || method.len() > 100
        || method.starts_with("secrets.")
    {
        return Err(String::from("Invalid desktop RPC request"));
    }
    Ok(())
}

fn publish(listener: &Listener, message: Value) {
    if let Ok(listener) = listener.lock() {
        if let Some(channel) = listener.as_ref() {
            let _ = channel.send(message);
        }
    }
}

fn record(path: &PathBuf, event: &str) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", json!({"time":timestamp, "event":event}));
    }
}

async fn write(input: &mut tokio::process::ChildStdin, frame: &str) -> Result<(), ()> {
    timeout(WRITE_LIMIT, async {
        input.write_all(frame.as_bytes()).await?;
        input.write_all(b"\n").await
    })
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}

async fn run(
    mut guard: GuardedChild,
    mut requests: mpsc::Receiver<String>,
    mut stop: watch::Receiver<bool>,
    listener: &Listener,
    ready: tokio::sync::oneshot::Sender<()>,
) -> Result<(), ()> {
    let mut input = guard.child.stdin.take().ok_or(())?;
    let output = guard.child.stdout.take().ok_or(())?;
    let mut lines = BufReader::new(output).lines();
    let handshake = async {
        input.write_all(&[1]).await.map_err(|_| ())?;
        if lines.next_line().await.map_err(|_| ())?.as_deref() != Some("ready") {
            return Err(());
        }
        write(
            &mut input,
            &json!({"jsonrpc":"2.0","id":PING,"method":"engine.hello","params":{}}).to_string(),
        )
        .await?;
        let line = lines.next_line().await.map_err(|_| ())?.ok_or(())?;
        let reply: Value = serde_json::from_str(&line).map_err(|_| ())?;
        if reply["id"] != PING
            || reply["result"]["protocolVersion"] != 1
            || reply["result"]["engineVersion"] != env!("CARGO_PKG_VERSION")
        {
            return Err(());
        }
        Ok(())
    };
    let result = if matches!(
        timeout(Duration::from_secs(10), handshake).await,
        Ok(Ok(()))
    ) {
        let _ = ready.send(());
        let mut pending = HashMap::new();
        let mut clock = interval(Duration::from_secs(1));
        let mut last_ping = Instant::now();
        let mut awaiting_ping = false;
        loop {
            tokio::select! {
                _ = stop.changed() => break Ok(()),
                line = lines.next_line() => {
                    let Ok(Some(line)) = line else { break Err(()); };
                    if line.len() > MAX_FRAME_BYTES { break Err(()); }
                    let Ok(reply) = serde_json::from_str::<Value>(&line) else { break Err(()); };
                    if reply["id"] == PING {
                        if reply["result"]["protocolVersion"] != 1 { break Err(()); }
                        awaiting_ping = false;
                    } else if let Some(id) = reply["id"].as_u64() {
                        if pending.remove(&id).is_some() {
                            publish(listener, json!({"frame": line}));
                        }
                    } else if reply["method"].is_string() {
                        publish(listener, json!({"frame": line}));
                    }
                },
                request = requests.recv() => {
                    let Some(frame) = request else { break Ok(()); };
                    if frame == RESET {
                        pending.clear();
                        if write(&mut input, RESET).await.is_err() { break Err(()); }
                        continue;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(&frame) else { break Err(()); };
                    let Some(id) = value["id"].as_u64() else { break Err(()); };
                    if pending.len() >= MAX_PENDING || pending.contains_key(&id) {
                        // An ID is unique for a renderer; on protocol violation reset the link.
                        break Err(());
                    }
                    if write(&mut input, &frame).await.is_err() { break Err(()); }
                    pending.insert(id, Instant::now());
                },
                _ = clock.tick() => {
                    if last_ping.elapsed() >= WRITE_LIMIT {
                        if awaiting_ping { break Err(()); }
                        if write(&mut input, &json!({"jsonrpc":"2.0","id":PING,"method":"engine.hello","params":{}}).to_string()).await.is_err() {
                            break Err(());
                        }
                        last_ping = Instant::now();
                        awaiting_ping = true;
                    }
                    pending.retain(|id, started| {
                        if started.elapsed() < REQUEST_LIMIT { return true; }
                        publish(listener, json!({"frame": json!({
                            "jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"Desktop RPC timed out"}
                        }).to_string()}));
                        false
                    });
                }
            }
        }
    } else {
        Err(())
    };
    drop(input);
    let _ = timeout(WRITE_LIMIT, guard.child.wait()).await;
    result
}

#[cfg(test)]
mod tests {
    use super::validate_request;

    #[test]
    fn only_single_public_requests_are_forwarded() {
        assert!(validate_request(r#"{"jsonrpc":"2.0","id":1,"method":"engine.hello"}"#).is_ok());
        assert!(validate_request(
            r#"{"jsonrpc":"2.0","id":"desktop-heartbeat","method":"engine.hello"}"#
        )
        .is_err());
        assert!(validate_request(r#"{"jsonrpc":"2.0","id":2,"method":"secrets.get"}"#).is_err());
        assert!(validate_request("{\"id\":1}\n{\"id\":2}").is_err());
    }
}
