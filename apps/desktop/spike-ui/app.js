const status = document.querySelector("#status");
const check = document.querySelector("#check-clis");
const cliStatus = document.querySelector("#cli-status");
const { invoke } = window.__TAURI__.core;

check.addEventListener("click", async () => {
  check.disabled = true;
  cliStatus.textContent = "Checking for installed CLIs…";
  try {
    const result = await invoke("check_provider_clis");
    cliStatus.textContent = Object.entries(result)
      .map(([name, found]) => `${name}: ${found ? "found" : "missing"}`)
      .join(" · ");
  } catch (error) {
    cliStatus.textContent = `CLI check failed. ${String(error)}`;
  } finally {
    check.disabled = false;
  }
});

try {
  const result = await invoke("engine_hello");
  status.textContent = `Engine ${result.engineVersion} connected using protocol ${result.protocolVersion}.`;
} catch (error) {
  status.textContent = `Engine connection failed. ${String(error)}`;
}
