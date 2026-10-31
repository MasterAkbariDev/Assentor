import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import type { EngineState, EngineStore } from "./engineStore.js";

const StoreContext = createContext<EngineStore | null>(null);

export function EngineStoreProvider({ store, children }: { store: EngineStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** Select from the engine store; re-renders only when the selected value changes. */
export function useEngine<T>(selector: (state: EngineState) => T): T {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error("useEngine must be used inside <EngineStoreProvider>");
  }
  return useStore(store, selector);
}
