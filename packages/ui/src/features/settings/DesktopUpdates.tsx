import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { useToast } from "../../shell/Toasts.js";

const documentation = "https://github.com/MasterAkbariDev/Assentor";

export function DesktopUpdates() {
  const [channel, setChannel] = useState<"stable" | "beta">("stable");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function update() {
    setBusy(true);
    try {
      const result = await invoke<{ enabled: boolean; version?: string }>("desktop_update", { channel });
      if (!result.enabled) toast("Updates are unavailable in this build.");
      else if (!result.version) toast("No update is available on this channel.");
      else if (window.confirm(`Install Assentor ${result.version}? Running sessions will stop.`)) {
        await invoke("desktop_update", { channel, confirmVersion: result.version });
      }
    } catch (error) {
      toast(String(error), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="desktop-updates-title" className="settings-section">
      <h2 id="desktop-updates-title">Desktop updates</h2>
      <div className="settings-actions">
        <label>Channel{" "}
          <select disabled={busy} value={channel} onChange={(event) => setChannel(event.target.value === "beta" ? "beta" : "stable")}>
            <option value="stable">Stable</option>
            <option value="beta">Beta</option>
          </select>
        </label>
        <button type="button" disabled={busy} onClick={() => void update()}>{busy ? "Working…" : "Check for updates"}</button>
        <button type="button" onClick={() => void invoke("os_open_external", { url: documentation }).catch(() => toast("Could not open documentation.", "error"))}>
          Documentation
        </button>
      </div>
    </section>
  );
}
