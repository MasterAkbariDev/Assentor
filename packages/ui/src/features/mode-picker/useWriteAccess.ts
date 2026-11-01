import { useEffect, useState } from "react";
import { useRpc } from "../../transport/context.js";
import { useEngine } from "../../store/context.js";

/** Methods the new-session flow calls. `engine.hello` lists only the methods this connection may call. */
const REQUIRED = ["session.create", "session.start"] as const;

export type WriteAccess = { state: "checking" } | { state: "allowed" } | { state: "denied"; reason: string };

const CONNECTION_REASON: Record<string, string> = {
  connecting: "Connecting to the engine…",
  reconnecting: "Reconnecting to the engine. Sessions can be created once it is back.",
  unauthorized: "This link is no longer valid, so sessions can't be created.",
  no_token: "Open the link printed by `assentor serve` to create sessions.",
};

/**
 * Whether this connection can create and start sessions. Asks `engine.hello` for the
 * capabilities once the link is open (the transport has no write flag yet).
 */
export function useWriteAccess(): WriteAccess {
  const rpc = useRpc();
  const connection = useEngine((s) => s.connection);
  const [access, setAccess] = useState<WriteAccess>({ state: "checking" });

  useEffect(() => {
    if (connection !== "connected") {
      setAccess({ state: "denied", reason: CONNECTION_REASON[connection] ?? "Not connected to the engine." });
      return;
    }
    let current = true;
    setAccess({ state: "checking" });
    rpc.call("engine.hello", { client: "assentor-web" }).then(
      (hello) => {
        if (!current) return;
        const writable = REQUIRED.every((method) => hello.capabilities.includes(method));
        setAccess(
          writable
            ? { state: "allowed" }
            : { state: "denied", reason: "This connection is read-only, so sessions can't be created from it." },
        );
      },
      () => {
        if (current) setAccess({ state: "denied", reason: "Could not check what this connection may do." });
      },
    );
    return () => {
      current = false;
    };
  }, [rpc, connection]);

  return access;
}
