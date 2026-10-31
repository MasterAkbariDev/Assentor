import type { Transport } from "./types.js";

/** A transport that never connects, for when there is nothing to connect with (no token). */
export const closedTransport: Transport = {
  call: () => Promise.reject(new Error("Not connected")),
  subscribe: () => Promise.reject(new Error("Not connected")),
  onStatus: (listener) => {
    listener("closed");
    return () => undefined;
  },
  close: () => undefined,
};
