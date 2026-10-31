/**
 * Browser-safe RPC entry, kept for old imports: the client now lives in
 * `#assentor/protocol/rpc-client.js` and the contract in
 * `#assentor/protocol/rpc.js`. Never import `./index.js` from a browser
 * (it also exports the Node-only server and transports).
 */
export * from "#assentor/protocol/rpc-client.js";
export * from "#assentor/protocol/rpc.js";
