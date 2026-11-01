import { useEffect, useState } from "react";
import type { RpcMethodName } from "#assentor/protocol/rpc.js";
import { useEngine } from "../../store/context.js";
import { useRpc } from "../../transport/context.js";

/**
 * The methods this connection may call, from `engine.hello` (its `capabilities`).
 * A read-only connection (`assentor serve`) lists only read methods, so a write
 * control checks its method here. Undefined until the first answer on a connected link.
 * shortcut: T04-12 adds a `canWrite` signal to the transport; switch to it when it lands.
 */
export function useCallableMethods(): ReadonlySet<string> | undefined {
  const rpc = useRpc();
  const connection = useEngine((s) => s.connection);
  const [methods, setMethods] = useState<ReadonlySet<string>>();
  useEffect(() => {
    if (connection !== "connected") {
      setMethods(undefined);
      return;
    }
    let live = true;
    rpc.call("engine.hello").then(
      (hello) => {
        if (live) setMethods(new Set(hello.capabilities));
      },
      () => {
        if (live) setMethods(new Set());
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, connection]);
  return methods;
}

/** Why a write control is disabled, or undefined when `method` may run. */
export function disabledReason(methods: ReadonlySet<string> | undefined, method: RpcMethodName): string | undefined {
  if (methods === undefined) return "Checking write access…";
  if (!methods.has(method)) return "Read-only connection: assentor serve only watches. Run the matching CLI command instead.";
  return undefined;
}
