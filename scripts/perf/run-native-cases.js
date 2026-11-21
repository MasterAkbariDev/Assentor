(() => {
  const suites = [
    ["cpu", "seats=6&rate=500", 12, 1],
    ["rate", "seats=6&rate=25,50,100,250,500,1000", 5, 3],
    ["coalescer", "seats=6&rate=250,1000&coalesce=raf,16,33,50,100", 5, 3],
    ["seats", "seats=6,12,24,48,96&rate=50", 5, 3],
  ];
  const key = "assentor.native-webview-fixture";
  const results = JSON.parse(sessionStorage.getItem(key) ?? "[]");
  const [name, query, duration, repeat] = suites[results.length];
  location.hash = `#/dev/fixtures?perf=1&autorun=1&duration=${duration}&repeat=${repeat}&${query}`;
  let sampling = false;
  const timer = setInterval(() => {
    const run = window.__perfResults;
    if (name === "cpu" && run && !run.done && !sampling) {
      sampling = true;
      void window.__TAURI_INTERNALS__.invoke("report_webview_fixture", { report: { sampling: true } });
    }
    if (!run?.done) return;
    clearInterval(timer);
    if (run.error) {
      void window.__TAURI_INTERNALS__.invoke("report_webview_fixture", { report: { error: run.error } });
      return;
    }
    results.push({ name, ...run });
    if (results.length < suites.length) {
      sessionStorage.setItem(key, JSON.stringify(results));
      location.reload();
    } else {
      sessionStorage.removeItem(key);
      void window.__TAURI_INTERNALS__.invoke("report_webview_fixture", { report: results });
    }
  }, 250);
})();
