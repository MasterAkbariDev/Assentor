import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Transport } from "./types.js";

const TransportContext = createContext<Transport | undefined>(undefined);

export function TransportProvider({ transport, children }: { transport: Transport; children: ReactNode }) {
  return <TransportContext.Provider value={transport}>{children}</TransportContext.Provider>;
}

/** The engine seam for components: `const rpc = useRpc(); await rpc.call("sessions.list")`. */
export function useRpc(): Transport {
  const transport = useContext(TransportContext);
  if (!transport) {
    throw new Error("useRpc() needs a <TransportProvider>");
  }
  return transport;
}

/** Whether the engine granted this connection write access; re-reads on every status change. */
export function useCanWrite(): boolean {
  const rpc = useRpc();
  const [canWrite, setCanWrite] = useState(rpc.canWrite);
  useEffect(() => rpc.onStatus(() => setCanWrite(rpc.canWrite)), [rpc]);
  return canWrite;
}
