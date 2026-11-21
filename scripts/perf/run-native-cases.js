(() => {
  const suites = [
    ["cpu", "seats=6&rate=500", 12, 1],
    ["rate", "seats=6&rate=25,50,100,250,500,1000", 5, 3],
    ["coalescer", "seats=6&rate=250,1000&coalesce=raf,16,33,50,100", 5, 3],
    ["seats", "seats=6,12,24,48,96&rate=50", 5, 3],
  ];
  const key = "assentor.native-webview-fixture";
  const results = JSON.parse(sessionStorage.getItem(key) ?? "[]");
  const [name, query, duration, repeat] = suites[results.length];
  location.hash = `#/dev/fixtures?perf=1&autorun=1&duration=${duration}&repeat=${repeat}&${query}`;
  let sampling = false;
  const timer = setInterval(() => {
    const run = window.__perfResults;
    if (name === "cpu" && run && !run.done && !sampling) {
      sampling = true;
      void window.__TAURI_INTERNALS__.invoke("report_webview_fixture", { report: { sampling: true } });
    }
    if (!run?.done) return;
    clearInterval(timer);
    if (run.error) {
      void window.__TAURI_INTERNALS__.invoke("report_webview_fixture", { report: { error: run.error } });
      return;
    }
    results.push({ name, ...run });
    if (results.length < suites.length) {
      sessionStorage.setItem(key, JSON.stringify(results));
      location.reload();
    } else {
      sessionStorage.removeItem(key);
      void verifyNativeRpc().then(
        () => window.__TAURI_INTERNALS__.invoke("report_webview_fixture", { report: results }),
        (error) => window.__TAURI_INTERNALS__.invoke("report_webview_fixture", { report: { error: String(error) } }),
      );
    }
  }, 250);

  async function verifyNativeRpc() {
    const ipc = window.__TAURI_INTERNALS__;
    const id = 619;
    let resolve;
    const response = new Promise((done) => { resolve = done; });
    const callback = ipc.transformCallback(({ message }) => {
      if (message?.frame) {
        const reply = JSON.parse(message.frame);
        if (reply.id === id) resolve(reply);
      }
    });
    let timer;
    try {
      const connection = await ipc.invoke("engine_connect", { channel: `__CHANNEL__:${callback}` });
      if (connection.writeGranted !== true) throw new Error("Native engine denied desktop write access.");
      const frame = JSON.stringify({ jsonrpc: "2.0", id, method: "prompt.list", params: {} });
      await ipc.invoke("rpc_call", { generation: connection.generation, frame });
      const reply = await Promise.race([
        response,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Timed out waiting for the native RPC reply.")), 10000);
        }),
      ]);
      if (!reply.result?.prompts?.length) throw new Error("Native RPC did not return the packaged prompts.");
    } finally {
      clearTimeout(timer);
      ipc.unregisterCallback(callback);
    }
  }
})();
