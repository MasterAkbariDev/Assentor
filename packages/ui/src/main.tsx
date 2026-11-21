import { isTauri } from "@tauri-apps/api/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { EngineController } from "./engine/controller.js";
import { createEngineStore } from "./store/engineStore.js";
import { EngineStoreProvider } from "./store/context.js";
import { takeToken } from "./transport/token.js";
import { TransportProvider } from "./transport/context.js";
import { closedTransport } from "./transport/closed.js";
import { connectWebSocket, engineUrl } from "./transport/websocket.js";
import { WebSocketTransport } from "./transport/websocketTransport.js";
import { createTauriTransport } from "./transport/tauriTransport.js";
import { ToastProvider } from "./shell/Toasts.js";
import { notifyDesktop, watchDesktop } from "./shell/desktopEvents.js";
import "./styles.css";

const store = createEngineStore();
const token = takeToken();

let transport;
if (isTauri()) {
  transport = createTauriTransport();
  watchDesktop(store);
  new EngineController({ store, transport, onEvent: notifyDesktop }).start();
} else if (token) {
  transport = new WebSocketTransport({ connect: () => connectWebSocket(engineUrl(), token) });
  new EngineController({ store, transport }).start();
} else {
  // No token: nothing can connect, so give `useRpc()` a transport that is already closed.
  transport = closedTransport;
  store.getState().setConnection("no_token");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EngineStoreProvider store={store}>
      <TransportProvider transport={transport}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </TransportProvider>
    </EngineStoreProvider>
  </StrictMode>,
);
