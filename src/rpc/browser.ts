/**
 * Browser-safe RPC entry (no Node imports): the typed client and the
 * contract. The web UI imports from here, not from `./index.js`, which also
 * exports the Node-only server and transports.
 */
export { RpcClient, RpcRemoteError, type EventSubscriptionHandlers, type RpcClientTransport } from "./client.js";
export * from "../protocol/rpc.js";
