import { useState } from "react";
import type { RpcResult } from "#assentor/protocol/rpc.js";
import { useToast } from "../../shell/Toasts.js";
import { useRpc } from "../../transport/context.js";
import { LOGIN_HINTS, messageOf } from "./model.js";

type DoctorItem = RpcResult<"env.doctor">["items"][number];
type CliInfo = RpcResult<"env.detectClis">["clis"][number];

/** `disabledReason` is set when the connection cannot run the method: the button is off and the reason shown. */
interface CheckProps {
  disabledReason?: string;
}

/** Runs `env.doctor` on request; each check shows its status as text and its detail (the fix hint). */
export function DoctorCheck({ disabledReason }: CheckProps) {
  const rpc = useRpc();
  const [items, setItems] = useState<DoctorItem[]>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const run = async () => {
    setRunning(true);
    setError(undefined);
    try {
      setItems((await rpc.call("env.doctor")).items);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setRunning(false);
    }
  };
  return (
    <div>
      <button
        type="button"
        onClick={run}
        disabled={disabledReason !== undefined || running}
        aria-describedby={disabledReason ? "doctor-reason" : undefined}
      >
        {running ? "Running…" : "Run doctor"}
      </button>
      {disabledReason ? <p id="doctor-reason" className="field-hint">{disabledReason}</p> : null}
      {error ? <p role="alert" className="notice error">{error}</p> : null}
      {items ? (
        items.length === 0 ? (
          <p className="empty">The doctor returned no checks.</p>
        ) : (
          <ul className="check-list" aria-label="Doctor results">
            {items.map((item, index) => (
              <li key={`${index}-${item.name}`} className="check">
                <span aria-hidden="true">{item.ok ? "✓" : "✗"}</span>{" "}
                <strong>{item.name}</strong>{" "}
                <span className={item.ok ? "check-ok" : "check-fail"}>{item.ok ? "OK" : "Needs attention"}</span>
                {item.detail ? <p className="check-detail">{item.detail}</p> : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

/** Runs `env.detectClis` on request: installed, available and logged-in state, and the login command to copy. */
export function CliCheck({ disabledReason }: CheckProps) {
  const rpc = useRpc();
  const toast = useToast();
  const [clis, setClis] = useState<CliInfo[]>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const run = async () => {
    setRunning(true);
    setError(undefined);
    try {
      setClis((await rpc.call("env.detectClis")).clis);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setRunning(false);
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Login command copied");
    } catch {
      toast("Could not copy. Select the command and copy it by hand.", "error");
    }
  };
  return (
    <div>
      <button
        type="button"
        onClick={run}
        disabled={disabledReason !== undefined || running}
        aria-describedby={disabledReason ? "cli-reason" : undefined}
      >
        {running ? "Detecting…" : "Detect CLIs"}
      </button>
      {disabledReason ? <p id="cli-reason" className="field-hint">{disabledReason}</p> : null}
      {error ? <p role="alert" className="notice error">{error}</p> : null}
      {clis ? (
        clis.length === 0 ? (
          <p className="empty">No CLIs known.</p>
        ) : (
          <ul className="check-list" aria-label="CLI detection results">
            {clis.map((cli) => {
              const hint = LOGIN_HINTS[cli.id];
              return (
                <li key={cli.id} className="check">
                  <strong>{cli.name}</strong>{" "}
                  <span>
                    {cli.available ? "Available" : cli.installed ? "Installed, not available" : "Not installed"}
                    {cli.version ? ` · ${cli.version}` : ""}
                  </span>{" "}
                  <span className={cli.authenticated === true ? "check-ok" : "check-muted"}>
                    {cli.authenticated === true ? "Logged in" : cli.authenticated === false ? "Not logged in" : "Login not checked"}
                  </span>
                  {cli.error ? <p className="check-detail">{cli.error}</p> : null}
                  {cli.authenticated !== true && hint ? (
                    <p className="check-detail">
                      To log in, run <code>{hint}</code> in a terminal.{" "}
                      <button type="button" className="link-button" onClick={() => copy(hint)}>
                        Copy login command
                      </button>
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}
