import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { createEngineStore, type EngineStore } from "../store/engineStore.js";
import { EngineStoreProvider } from "../store/context.js";
import { TransportProvider } from "../transport/context.js";
import { mockTransport } from "../transport/mock.js";
import type { Transport } from "../transport/types.js";
import { ToastProvider } from "../shell/Toasts.js";

/** Render `ui` with a fresh engine store and `mockTransport()` (or the given ones), plus toasts. */
export function renderWithStore(
  ui: ReactElement,
  store: EngineStore = createEngineStore(),
  transport: Transport = mockTransport(),
): RenderResult & { store: EngineStore; transport: Transport } {
  const result = render(
    <EngineStoreProvider store={store}>
      <TransportProvider transport={transport}>
        <ToastProvider>{ui}</ToastProvider>
      </TransportProvider>
    </EngineStoreProvider>,
  );
  return { ...result, store, transport };
}
