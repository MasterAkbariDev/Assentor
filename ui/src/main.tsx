import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { EngineController } from "./engine/controller.js";
import { createEngineStore } from "./store/engineStore.js";
import { EngineStoreProvider } from "./store/context.js";
import { takeToken } from "./transport/token.js";
import { connectWebSocket, engineUrl } from "./transport/websocket.js";
import "./styles.css";

const store = createEngineStore();
const token = takeToken();

if (token) {
  const controller = new EngineController({
    store,
    connect: () => connectWebSocket(engineUrl(), token),
  });
  void controller.start();
} else {
  store.getState().setConnection("no_token");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EngineStoreProvider store={store}>
      <App />
    </EngineStoreProvider>
  </StrictMode>,
);
