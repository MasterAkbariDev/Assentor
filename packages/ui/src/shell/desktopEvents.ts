import { invoke } from "@tauri-apps/api/core";
import type { EngineEvent } from "#assentor/protocol/events.js";
import type { EngineStore } from "../store/engineStore.js";

export function watchDesktop(store: EngineStore): void {
  function deepLink() {
    const hash = window.location.hash;
    if (!hash.startsWith("#/sessions?")) return;
    const id = new URLSearchParams(hash.slice(hash.indexOf("?") + 1)).get("session");
    if (id && /^[\w-]{1,100}$/.test(id)) store.getState().select(id);
  }
  window.addEventListener("hashchange", deepLink);
  deepLink();
  let previous = "";
  store.subscribe((state) => {
    const sessions = state.sessions.filter((session) => /^(running|executing|reviewing|waiting|paused|planning)$/i.test(session.status ?? ""))
      .slice(0, 12).map(({ id, title, status }) => ({ id, title, status: status?.toLowerCase() }));
    const fingerprint = JSON.stringify(sessions);
    if (previous === fingerprint) return;
    previous = fingerprint;
    void invoke("update_tray", { sessions }).catch(() => undefined);
  });
}

export function notifyDesktop(event: EngineEvent): void {
  if (Date.now() - Date.parse(event.at) > 15_000) return;
  const kind = ({
    "session.completed": "completed",
    "session.failed": "failed",
    "user.question": "waiting",
  } as Record<string, string>)[event.type];
  if (kind) void invoke("os_notify", { kind, sessionId: event.sessionId }).catch(() => undefined);
}
