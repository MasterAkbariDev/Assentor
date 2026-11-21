import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useToast } from "./Toasts.js";

export function DesktopProject() {
  const [project, setProject] = useState<string>();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    void invoke<string>("current_project").then(setProject, () => undefined);
  }, []);

  async function choose() {
    if (!window.confirm("Switch project folders? This will stop any sessions running in this desktop window.")) return;
    setBusy(true);
    try {
      const next = await invoke<string | null>("choose_project");
      if (next && next !== project) {
        window.location.hash = "#/sessions";
        window.location.reload();
      }
    } catch (error) {
      toast(String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  const name = project?.split(/[\\/]/).filter(Boolean).at(-1);
  return (
    <button type="button" onClick={() => void choose()} disabled={busy} title={project}>
      {name ? `Project: ${name}` : "Open project folder"}
    </button>
  );
}
