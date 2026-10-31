import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { createEngineStore, type EngineStore } from "../store/engineStore.js";
import { EngineStoreProvider } from "../store/context.js";

/** Render `ui` with a fresh engine store (or the given one). */
export function renderWithStore(
  ui: ReactElement,
  store: EngineStore = createEngineStore(),
): RenderResult & { store: EngineStore } {
  const result = render(<EngineStoreProvider store={store}>{ui}</EngineStoreProvider>);
  return { ...result, store };
}
