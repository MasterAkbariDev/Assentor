import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AssentorConfigSchema } from "../../src/config/schema.js";
import {
  classifyRisk,
  DANGER_CATEGORIES,
  DangerAreaRuleSchema,
  MAX_RISK_DIFF_CHARS,
  MAX_RISK_PATH_CHARS,
  MAX_RISK_PATHS,
  MAX_RISK_REASONS,
  MAX_RISK_TASK_CHARS,
  RISK_UNSCANNED,
  type RiskInput,
} from "../../src/modes/danger.js";

const repo = path.resolve(import.meta.dirname, "../..");

function cats(input: RiskInput) {
  return classifyRisk(input).categories;
}

/** A one-file git diff that adds `lines` to `file`. */
function addDiff(file: string, lines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    "index 1111111..2222222 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -10,1 +10,${lines.length + 1} @@`,
    " const unchanged = 1;",
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

const NORMAL_FILE = "src/ui/board-view.ts";

describe("classifyRisk: every category, positive and negative", () => {
  const cases: Array<{
    category: (typeof DANGER_CATEGORIES)[number];
    path: string;
    line: string;
    task: string;
    safeLine: string;
    safeTask: string;
  }> = [
    {
      category: "process",
      path: "src/process/kill-tree.ts",
      line: 'const child = spawn("codex", args, { detached: true });',
      task: "Kill the running agent process when the turn times out",
      safeLine: "const total = items.length + 1;",
      safeTask: "Rename the board column title",
    },
    {
      category: "git",
      path: "src/worktrees/manager.ts",
      line: 'await run("git", ["worktree", "remove", dir]);',
      task: "Rebase the feature branch and force-push it",
      safeLine: "return labels.join(', ');",
      safeTask: "Align the table header text",
    },
    {
      category: "permissions",
      path: "src/seats/permission-check.ts",
      line: 'args.push("--dangerously-skip-permissions");',
      task: "Let edit seats bypass approvals in autopilot",
      safeLine: "const width = 80;",
      safeTask: "Add a dark theme colour",
    },
    {
      category: "secrets",
      path: "src/keys/vault.ts",
      line: "const value = await keytar.getPassword(service, account);",
      task: "Store the API key in the keychain",
      safeLine: "const count = rows.filter(Boolean).length;",
      safeTask: "Sort the roster table by speed",
    },
    {
      category: "network",
      path: "src/serve/server.ts",
      line: "httpServer.listen(port, host);",
      task: "Expose a websocket server for the web app",
      safeLine: "const label = `${name} (${count})`;",
      safeTask: "Fix the typo in the help text",
    },
    {
      category: "shell",
      path: "scripts/lib/helpers.sh",
      line: 'execFileAsync("bash", ["-lc", userCommand]);',
      task: "Resolve PATH from the login shell",
      safeLine: "const items = [] as string[];",
      safeTask: "Show the elapsed time in the footer",
    },
    {
      category: "paths",
      path: "src/session/cleanup.ts",
      line: "await fs.rm(dir, { recursive: true, force: true });",
      task: "Delete old session files after 30 days",
      safeLine: "const ok = value > 0;",
      safeTask: "Make the spinner smaller",
    },
    {
      category: "release",
      path: ".github/workflows/release.yml",
      line: "        NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
      task: "Sign and notarize the macOS release build",
      safeLine: "const title = 'Board';",
      safeTask: "Change the empty-state message",
    },
    {
      category: "contracts",
      path: "src/modes/lead/types.ts",
      line: "// BREAKING CHANGE: report status renamed",
      task: "Change the controller contract to add a new action",
      safeLine: "const n = 3;",
      safeTask: "Tweak the toast duration",
    },
    {
      category: "config",
      path: "src/config/load.ts",
      line: "await saveAssentorConfig(projectPath, config);",
      task: "Write a config migration for the old run.mode field",
      safeLine: "const big = n > 10;",
      safeTask: "Use a bolder font for headings",
    },
  ];

  for (const c of cases) {
    it(`${c.category}: flags the path`, () => {
      const result = classifyRisk({ paths: [c.path] });
      expect(result.level).toBe("danger");
      expect(result.categories).toContain(c.category);
      expect(result.reasons.join("\n")).toContain(c.path.toLowerCase());
    });

    it(`${c.category}: flags an added diff line and cites file:line`, () => {
      const result = classifyRisk({ diff: addDiff(NORMAL_FILE, [c.line]) });
      expect(result.categories).toContain(c.category);
      const reason = result.reasons.find((r) => r.startsWith(`${c.category}:`));
      expect(reason).toContain(`${NORMAL_FILE}:11 (+)`);
    });

    it(`${c.category}: flags a removed diff line`, () => {
      const diff = [`--- a/${NORMAL_FILE}`, `+++ b/${NORMAL_FILE}`, "@@ -5,2 +5,1 @@", ` ${c.safeLine}`, `-${c.line}`].join("\n");
      const result = classifyRisk({ diff });
      expect(result.categories).toContain(c.category);
      expect(result.reasons.find((r) => r.startsWith(`${c.category}:`))).toContain(`${NORMAL_FILE}:6 (-)`);
    });

    it(`${c.category}: flags the task text`, () => {
      expect(cats({ taskText: c.task })).toContain(c.category);
    });

    it(`${c.category}: leaves an ordinary change and task alone`, () => {
      const result = classifyRisk({
        taskText: c.safeTask,
        paths: [NORMAL_FILE],
        diff: addDiff(NORMAL_FILE, [c.safeLine]),
      });
      expect(result).toEqual({ level: "normal", categories: [], reasons: [] });
    });
  }

  it("empty input is normal", () => {
    expect(classifyRisk({})).toEqual({ level: "normal", categories: [], reasons: [] });
    expect(classifyRisk({ taskText: "", paths: [], diff: "" }).level).toBe("normal");
  });

  it("context lines of a changed hunk are scanned and cited", () => {
    const diff = [`--- a/${NORMAL_FILE}`, `+++ b/${NORMAL_FILE}`, "@@ -1,2 +1,2 @@", " spawn(cmd);", "-a", "+b"].join("\n");
    const result = classifyRisk({ diff });
    expect(result.categories).toContain("process");
    expect(result.reasons.join("\n")).toContain(`${NORMAL_FILE}:1 (context)`);
  });

  it("context of a hunk without a change is not scanned", () => {
    const diff = [`--- a/${NORMAL_FILE}`, `+++ b/${NORMAL_FILE}`, "@@ -1,2 +1,2 @@", " spawn(cmd);", " x"].join("\n");
    expect(classifyRisk({ diff }).level).toBe("normal");
  });

  it("names a path mentioned in the task text", () => {
    const result = classifyRisk({ taskText: "Fix the off-by-one in src/process/kill-tree.ts." });
    expect(result.categories).toContain("process");
    expect(result.reasons.join("\n")).toContain('"src/process/kill-tree.ts"');
  });

  it("flags a secret value without quoting it back", () => {
    const token = `ghp_${"a1B2".repeat(8)}`;
    const result = classifyRisk({ diff: addDiff(NORMAL_FILE, [`const t = "${token}";`]), taskText: `use ${token}` });
    expect(result.categories).toContain("secrets");
    expect(result.reasons.join("\n")).not.toContain(token);
  });

  it("redacts secrets in quoted excerpts", () => {
    const key = `sk-${"x".repeat(30)}`;
    const result = classifyRisk({ diff: addDiff(NORMAL_FILE, [`spawn(cmd, { env: { OPENAI: "${key}" } });`]) });
    expect(result.reasons.join("\n")).not.toContain(key);
  });

  it("strips control and bidi characters from reasons", () => {
    const result = classifyRisk({ diff: addDiff("src/ui/a\u202e.ts", ["spawn(x); \u001b[2J\u0007"]), taskText: "kill the process \u001b]0;x" });
    expect(result.categories).toContain("process");
    expect(result.reasons.join("\n")).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u202e]/);
  });

  it("flags secrets files by name", () => {
    for (const p of [".env", "config/.env.production", "certs/server.pem", "deploy/id_rsa", "home/.ssh/known_hosts"]) {
      expect(cats({ paths: [p] }), p).toContain("secrets");
    }
  });

  it("flags native binaries and scripts as shell", () => {
    for (const p of ["vendor/tool.exe", "lib/addon.node", "tools/run.ps1", "Makefile"]) {
      expect(cats({ paths: [p] }), p).toContain("shell");
    }
  });
});

describe("classifyRisk: this repo's real danger files (false-negative guard)", () => {
  const listed = (dir: string, filter: (name: string) => boolean = () => true) =>
    readdirSync(path.join(repo, dir))
      .filter(filter)
      .map((name) => `${dir}/${name}`);

  const dangerFiles = [
    ...listed("src/process"),
    ...listed("src/keys"),
    ...listed("src/git"),
    ...listed("src/security"),
    ...listed("src/worktrees"),
    ...listed("src/serve"),
    ...listed("src/self"),
    ...listed("src/executors"),
    ...listed("scripts", (n) => /^(?:un)?install|^update/.test(n)),
    ...listed(".github/workflows"),
    ...listed("src/seats"),
    "src/core/seats.ts",
    "src/rpc/server.ts",
    "src/config/load.ts",
    "src/config/schema.ts",
    "src/modes/lead/types.ts",
    "bin/assentor",
    "package.json",
    "pnpm-lock.yaml",
  ];

  it("found the expected files on disk", () => {
    expect(dangerFiles.filter((f) => f.startsWith("src/process/")).length).toBeGreaterThanOrEqual(3);
    expect(dangerFiles.filter((f) => f.startsWith("scripts/install")).length).toBeGreaterThanOrEqual(2);
  });

  for (const file of dangerFiles) {
    it(`${file} is danger`, () => {
      expect(classifyRisk({ paths: [file] }).level).toBe("danger");
    });
  }

  it("also when only a diff touches them", () => {
    for (const file of dangerFiles) {
      expect(classifyRisk({ diff: addDiff(file, ["const x = 1;"]) }).level, file).toBe("danger");
    }
  });

  it("ordinary files stay normal", () => {
    for (const file of ["src/modes/lead/board.ts", "src/review/plan-explain.ts", "src/tui/App.tsx", "docs/plans/modes.md", "ui/src/components/Board.tsx", "README.md"]) {
      expect(classifyRisk({ paths: [file] }).categories, file).toEqual([]);
    }
  });
});

describe("classifyRisk: path normalisation cannot dodge a rule", () => {
  const evasions: Array<[string, string]> = [
    ["SRC\\PROCESS\\kill-tree.ts", "process"],
    ["src\\git\\local.ts", "git"],
    ["Src/Keys/Vault.TS", "secrets"],
    ["./src/./git//local.ts", "git"],
    ["docs/../src/keys/vault.ts", "secrets"],
    ["src/ui/../../src/process/run-shell.ts", "process"],
    ["src/process./kill-tree.ts", "process"],
    ["src/process /kill-tree.ts", "process"],
    ["src/process. . /kill-tree.ts", "process"],
    ["C:\\work\\repo\\src\\git\\local.ts", "git"],
    ["/abs/repo/.GITHUB/workflows/ci.yml", "release"],
    ["CONFIG/.ENV", "secrets"],
    ["scripts/INSTALL.SH", "release"],
  ];
  for (const [raw, category] of evasions) {
    it(`${JSON.stringify(raw)} → ${category}`, () => {
      expect(cats({ paths: [raw] })).toContain(category);
    });
  }

  it("a path that climbs above the root is a paths danger", () => {
    for (const raw of ["../outside.txt", "src/../../etc/passwd", "..\\..\\Windows\\System32\\x.dll", "a/b/../../../c"]) {
      const result = classifyRisk({ paths: [raw] });
      expect(result.categories, raw).toContain("paths");
      expect(result.reasons.join("\n"), raw).toContain("escapes the project root");
    }
  });

  it("home, short-name and stream paths are paths dangers", () => {
    expect(classifyRisk({ paths: ["~/.bashrc"] }).reasons.join("\n")).toContain("home directory");
    expect(classifyRisk({ paths: ["src/PROCES~1/kill.ts"] }).reasons.join("\n")).toContain("short (8.3) name");
    expect(classifyRisk({ paths: ["src/app.ts::$DATA"] }).reasons.join("\n")).toContain("alternate data stream");
  });

  it("a drive-letter path inside projectRoot is classified relative to it", () => {
    expect(classifyRisk({ paths: ["C:\\repo\\src\\ui\\board-view.ts"] }, { projectRoot: "c:/REPO" }).level).toBe("normal");
  });

  it("`..` that stays inside the project is not an escape", () => {
    expect(classifyRisk({ paths: ["src/ui/../ui/board-view.ts"] }).level).toBe("normal");
  });

  it("diff paths are normalised too", () => {
    const diff = ["diff --git a/src/ui/../process/x.ts b/src/ui/../process/x.ts", "--- a/src/ui/../process/x.ts", "+++ b/src/ui/../process/x.ts"].join("\n");
    expect(cats({ diff })).toContain("process");
  });
});

describe("classifyRisk: diff shapes", () => {
  it("checks both sides of a pure rename", () => {
    const out = ["diff --git a/src/process/kill-tree.ts b/src/util/tree.ts", "similarity index 100%", "rename from src/process/kill-tree.ts", "rename to src/util/tree.ts"].join("\n");
    expect(cats({ diff: out })).toContain("process");
    const into = ["diff --git a/src/util/tree.ts b/src/keys/tree.ts", "similarity index 100%", "rename from src/util/tree.ts", "rename to src/keys/tree.ts"].join("\n");
    expect(cats({ diff: into })).toContain("secrets");
  });

  it("checks rename lines even without a diff --git header", () => {
    expect(cats({ diff: "rename from src/git/local.ts\nrename to src/ui/local.ts" })).toContain("git");
    expect(cats({ diff: "copy from src/ui/a.ts\ncopy to src/serve/a.ts" })).toContain("network");
  });

  it("checks a rename with edits on both paths", () => {
    const diff = [
      "diff --git a/src/ui/old.ts b/src/ui/new.ts",
      "similarity index 90%",
      "rename from src/ui/old.ts",
      "rename to src/ui/new.ts",
      "--- a/src/ui/old.ts",
      "+++ b/src/ui/new.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    expect(classifyRisk({ diff }).level).toBe("normal");
  });

  it("checks binary diff paths and does not scan the binary payload", () => {
    const binary = (file: string) =>
      [
        `diff --git a/${file} b/${file}`,
        "new file mode 100644",
        "index 0000000..d00491f",
        "GIT binary patch",
        "literal 12",
        "Tc${spawn(x) secret--dangerously-skip-permissions",
        "",
        "literal 0",
        "HcmV?d00001",
      ].join("\n");
    expect(cats({ diff: binary("src/keys/vault.bin") })).toContain("secrets");
    expect(classifyRisk({ diff: binary("assets/logo.png") }).level).toBe("normal");
  });

  it("checks `Binary files … differ` lines", () => {
    expect(cats({ diff: "Binary files a/src/git/pack.idx and b/src/git/pack.idx differ" })).toContain("git");
    expect(cats({ diff: "Binary files /dev/null and b/dist/assentor.exe differ" })).toContain("shell");
  });

  it("decodes git-quoted paths and paths with spaces", () => {
    const quoted = ['diff --git "a/src/process/caf\\303\\251 x.ts" "b/src/process/caf\\303\\251 x.ts"', '--- "a/src/process/caf\\303\\251 x.ts"', '+++ "b/src/process/caf\\303\\251 x.ts"'].join("\n");
    const result = classifyRisk({ diff: quoted });
    expect(result.categories).toContain("process");
    expect(result.reasons.join("\n")).toContain("café x.ts");
    expect(cats({ diff: "diff --git a/my dir/src/git/a b.ts b/my dir/src/git/a b.ts" })).toContain("git");
  });

  it("checks no-prefix and plain unified diffs", () => {
    expect(cats({ diff: "diff --git src/keys/a.ts src/keys/a.ts" })).toContain("secrets");
    expect(cats({ diff: "--- src/serve/server.ts\t2026-01-01 10:00\n+++ src/serve/server.ts\t2026-01-02 10:00\n@@ -1 +1 @@\n-a\n+b" })).toContain("network");
  });

  it("scans content lines that look like headers inside a hunk", () => {
    const diff = [`--- a/${NORMAL_FILE}`, `+++ b/${NORMAL_FILE}`, "@@ -1,2 +1,2 @@", "--- removed rm -rf line", "+++ added git push --force line"].join("\n");
    expect(cats({ diff })).toEqual(expect.arrayContaining(["git", "paths"]));
  });

  it("handles CRLF diffs and patches without headers", () => {
    expect(cats({ diff: addDiff(NORMAL_FILE, ["child_process.exec(x);"]).replace(/\n/g, "\r\n") })).toContain("process");
    const result = classifyRisk({ diff: "+git reset --hard HEAD" });
    expect(result.categories).toContain("git");
    expect(result.reasons[0]).toContain("diff line 1");
  });

  it("checks the path of a combined (merge) diff and marks it unscanned", () => {
    expect(cats({ diff: "diff --cc src/git/local.ts\nindex 1,2..3\n@@@ -1,1 -1,1 +1,1 @@@" })).toEqual(["git", RISK_UNSCANNED]);
  });
});

describe("classifyRisk: huge input is never safe", () => {
  it("an over-limit diff is danger/unscanned even when the scanned part is benign", () => {
    const line = "+const value = 1;\n";
    const diff = `--- a/${NORMAL_FILE}\n+++ b/${NORMAL_FILE}\n@@ -1 +1,999999 @@\n${line.repeat(Math.ceil(MAX_RISK_DIFF_CHARS / line.length) + 10)}`;
    const result = classifyRisk({ diff });
    expect(result.level).toBe("danger");
    expect(result.categories).toEqual([RISK_UNSCANNED]);
    expect(result.reasons[0]).toContain("over the");
  }, 60_000);

  it("over-limit task text, too many paths and an over-long path are unscanned", () => {
    expect(cats({ taskText: "a ".repeat(MAX_RISK_TASK_CHARS) })).toContain(RISK_UNSCANNED);
    const paths = Array.from({ length: MAX_RISK_PATHS + 1 }, (_, i) => `src/ui/f${i}.ts`);
    expect(cats({ paths })).toEqual([RISK_UNSCANNED]);
    expect(cats({ paths: [`src/${"a".repeat(MAX_RISK_PATH_CHARS)}.ts`] })).toEqual([RISK_UNSCANNED]);
  }, 60_000);

  it("still reports danger found in the scanned part", () => {
    const diff = addDiff(NORMAL_FILE, ["spawn(cmd);"]) + "\n" + "+x\n".repeat(MAX_RISK_DIFF_CHARS);
    expect(cats({ diff })).toEqual(["process", RISK_UNSCANNED]);
  }, 60_000);

  it("stays fast on adversarial input (no ReDoS)", () => {
    // 200 KB is enough: a quadratic pattern would need ~10^10 steps here.
    const size = 200_000;
    const pieces = ["sk-", "safe", "spawn ", "-----BEGIN ", "process.env.", "[ ", "fs.rm", "git ", "a".repeat(50), " ", "~", "\\", "/", "save"];
    let body = "";
    for (let i = 0; body.length < size; i += 1) body += pieces[i % pieces.length];
    const started = performance.now();
    classifyRisk({ diff: `+${body}`, taskText: body, paths: [body.slice(0, MAX_RISK_PATH_CHARS)] });
    for (const unit of ["a", " ", "safe", "sk-", "-", "~1", "../", "a.", "\t"]) {
      const run = unit.repeat(size / unit.length);
      classifyRisk({ diff: `+${run}`, taskText: run, paths: [run.slice(0, MAX_RISK_PATH_CHARS)] });
    }
    classifyRisk({ diff: `diff --git a/${" b/".repeat(5_000)}\n` });
    classifyRisk({ paths: [`${"*a".repeat(1_000)}/${"a".repeat(2_000)}`] }, { extraRules: [{ name: "x", paths: ["*a*a*a*a*a*b"] }] });
    const hostile = Array.from({ length: 50 }, (_, i) => ({ name: `r${i}`, paths: Array.from({ length: 50 }, () => `${"*a".repeat(60)}*b`) }));
    expect(cats({ paths: Array.from({ length: 5_000 }, (_, i) => `${"a".repeat(MAX_RISK_PATH_CHARS)}${i}`) })).toEqual([RISK_UNSCANNED]);
    // Ordinary large changes stay within the matching budget.
    expect(cats({ paths: Array.from({ length: 5_000 }, (_, i) => `packages/app/src/features/area${i % 50}/components/widgets/view${i}/index.tsx`) })).toEqual([]);
    expect(classifyRisk({ paths: Array.from({ length: 200 }, (_, i) => `${"a".repeat(900)}/x${i}`) }, { extraRules: hostile }).categories).toEqual([RISK_UNSCANNED]);
    // Generous bound for a loaded machine; a ReDoS would take minutes.
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 120_000);

  it("caps the number of reasons", () => {
    const paths = Array.from({ length: 200 }, (_, i) => `src/process/f${i}.ts`);
    const result = classifyRisk({ paths });
    expect(result.reasons).toHaveLength(MAX_RISK_REASONS + 1);
    expect(result.reasons.at(-1)).toBe(`… and ${200 - MAX_RISK_REASONS} more matches`);
  });
});

describe("classifyRisk: determinism", () => {
  const input: RiskInput = {
    taskText: "Spawn the CLI and store the API key; release it",
    paths: ["src/keys/vault.ts", "src/process/run-shell.ts", ".github/workflows/ci.yml"],
    diff: addDiff("src/serve/server.ts", ["server.listen(0);", "git push --force"]),
  };

  it("same input, same output, many times", () => {
    const first = classifyRisk(input);
    for (let i = 0; i < 20; i += 1) expect(classifyRisk(input)).toEqual(first);
  });

  it("categories follow Danger-list order whatever the input order", () => {
    const reversed = classifyRisk({ ...input, paths: [...input.paths!].reverse() });
    expect(reversed.categories).toEqual(classifyRisk(input).categories);
    const order = reversed.categories.map((c) => DANGER_CATEGORIES.indexOf(c as never));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("does not mutate its input", () => {
    const frozen = Object.freeze({ ...input, paths: Object.freeze([...input.paths!]) });
    expect(() => classifyRisk(frozen)).not.toThrow();
  });
});

describe("classifyRisk: user danger areas (modes.cascade.dangerAreas)", () => {
  const payments = { name: "Payments", paths: ["src/billing"], keywords: ["refund", "stripe.charges"] };

  it("adds a custom category by path and by keyword", () => {
    expect(classifyRisk({ paths: ["SRC\\Billing\\invoice.ts"] }, { extraRules: [payments] }).categories).toEqual(["payments"]);
    expect(classifyRisk({ taskText: "Issue a Refund" }, { extraRules: [payments] }).categories).toEqual(["payments"]);
    expect(classifyRisk({ diff: addDiff(NORMAL_FILE, ["await stripe.charges.create(x);"]) }, { extraRules: [payments] }).categories).toEqual(["payments"]);
  });

  it("keywords are literal and whole-word", () => {
    expect(classifyRisk({ taskText: "refunded" }, { extraRules: [payments] }).level).toBe("normal");
    expect(classifyRisk({ taskText: "stripeXcharges" }, { extraRules: [payments] }).level).toBe("normal");
    const tricky = { name: "x", keywords: ["(a+)+$", "--force-push"] };
    expect(classifyRisk({ taskText: "a".repeat(5_000) + "!" }, { extraRules: [tricky] }).level).toBe("normal");
    expect(classifyRisk({ taskText: "use --force-push here" }, { extraRules: [tricky] }).categories).toContain("x");
  });

  it("cannot suppress a built-in rule", () => {
    const attempts = [{ name: "process", paths: [] as string[], keywords: [] as string[] }, { name: "process", paths: ["nothing-matches"] }];
    const result = classifyRisk({ paths: ["src/process/kill-tree.ts"] }, { extraRules: attempts });
    expect(result.categories).toEqual(["process"]);
  });

  it("custom names sort after built-ins and merge with a built-in of the same name", () => {
    const result = classifyRisk({ paths: ["src/billing/a.ts", "src/git/b.ts", "src/zeta/c.ts"] }, {
      extraRules: [{ name: "zeta", paths: ["zeta"] }, payments, { name: "git", paths: ["src/git"] }],
    });
    expect(result.categories).toEqual(["git", "payments", "zeta"]);
  });

  it("schema validates and normalises rules", () => {
    expect(DangerAreaRuleSchema.parse({ name: " Payments ", paths: ["src/billing"] })).toEqual({ name: "payments", paths: ["src/billing"], keywords: [] });
    expect(DangerAreaRuleSchema.safeParse({ name: "x" }).success).toBe(false);
    expect(DangerAreaRuleSchema.safeParse({ name: "bad name!", paths: ["a"] }).success).toBe(false);
    expect(DangerAreaRuleSchema.safeParse({ name: "x", keywords: ["a"] }).success).toBe(false);
  });

  it("is read from config at modes.cascade.dangerAreas", () => {
    const config = AssentorConfigSchema.parse({ modes: { cascade: { dangerAreas: [{ name: "payments", paths: ["src/billing"] }] } } });
    const rules = config.modes.cascade?.dangerAreas ?? [];
    expect(classifyRisk({ paths: ["src/billing/x.ts"] }, { extraRules: rules }).categories).toEqual(["payments"]);
    expect(AssentorConfigSchema.parse({}).modes.cascade).toBeUndefined();
  });
});

describe("classifyRisk: O2 review evasions", () => {
  const hdr = (f: string) => `diff --git a/${f} b/${f}\nindex 1111111..2222222 100644\n--- a/${f}\n+++ b/${f}\n`;

  describe("absolute paths and projectRoot", () => {
    for (const p of ["/etc/passwd", "C:/Windows/System32/drivers/etc/hosts", "\\\\host\\share\\x.ts", "/Users/me/.zshrc", "c:relative\\x.ts"]) {
      it(`${JSON.stringify(p)} is a paths danger without a root`, () => {
        const result = classifyRisk({ paths: [p] });
        expect(result.categories).toContain("paths");
        expect(result.reasons.join("\n")).toContain("absolute");
      });
    }

    it("`+++ /abs` in a diff is a paths danger", () => {
      const diff = "diff --git a/etc/cron.d/x b/etc/cron.d/x\n--- /etc/cron.d/x\n+++ /etc/cron.d/x\n@@ -0,0 +1 @@\n+* * * * * root echo";
      expect(cats({ diff })).toContain("paths");
    });

    it("an absolute path inside projectRoot is classified relative to it", () => {
      expect(classifyRisk({ paths: ["/work/repo/src/ui/a.ts"] }, { projectRoot: "/work/repo" })).toEqual({ level: "normal", categories: [], reasons: [] });
      expect(classifyRisk({ paths: ["/work/repo/src/process/x.ts"] }, { projectRoot: "/work/repo/" }).categories).toEqual(["process"]);
      expect(classifyRisk({ paths: ["/WORK/Repo/./src/../src/ui/a.ts"] }, { projectRoot: "/work/repo" }).level).toBe("normal");
    });

    it("an absolute path outside projectRoot is a paths danger", () => {
      for (const p of ["/work/repo2/src/ui/a.ts", "/work/repo/../other/a.ts", "/etc/passwd", "d:/repo/src/ui/a.ts"]) {
        const result = classifyRisk({ paths: [p] }, { projectRoot: "/work/repo" });
        expect(result.categories, p).toContain("paths");
        expect(result.reasons.join("\n"), p).toContain("outside the project root");
      }
    });
  });

  describe("git modes", () => {
    it("a symlink is a paths danger and its target is checked", () => {
      const out = "diff --git a/src/data b/src/data\nnew file mode 120000\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/data\n@@ -0,0 +1 @@\n+../../../../etc\n\\ No newline at end of file";
      const result = classifyRisk({ diff: out });
      expect(result.categories).toEqual(["paths"]);
      expect(result.reasons.join("\n")).toContain("is a symlink");
      expect(result.reasons.join("\n")).toContain("escapes the project root");
      const abs = "diff --git a/docs/notes b/docs/notes\nnew file mode 120000\nindex 0000000..1111111\n--- /dev/null\n+++ b/docs/notes\n@@ -0,0 +1 @@\n+/Users/me/Library";
      expect(classifyRisk({ diff: abs }).reasons.join("\n")).toContain("absolute");
      const inside = "diff --git a/docs/link b/docs/link\nnew file mode 120000\nindex 0000000..1111111\n--- /dev/null\n+++ b/docs/link\n@@ -0,0 +1 @@\n+../src/keys/vault.ts";
      expect(cats({ diff: inside })).toEqual(["secrets", "paths"]);
    });

    it("an existing symlink (index mode 120000) is a paths danger", () => {
      expect(cats({ diff: "diff --git a/l b/l\nindex 1111111..2222222 120000\n--- a/l\n+++ b/l\n@@ -1 +1 @@\n-a\n+b" })).toContain("paths");
    });

    it("a submodule (gitlink) is git and release", () => {
      const bump = "diff --git a/vendor/lib b/vendor/lib\nindex abc..def 160000\n--- a/vendor/lib\n+++ b/vendor/lib\n@@ -1 +1 @@\n-Subproject commit 1111111111111111111111111111111111111111\n+Subproject commit 2222222222222222222222222222222222222222";
      expect(cats({ diff: bump })).toEqual(["git", "release"]);
      const added = "diff --git a/vendor/lib b/vendor/lib\nnew file mode 160000\nindex 0000000..def\n--- /dev/null\n+++ b/vendor/lib\n@@ -0,0 +1 @@\n+Subproject commit 2222222222222222222222222222222222222222";
      expect(cats({ diff: added })).toEqual(["git", "release"]);
      expect(cats({ diff: `${hdr("vendor/x")}@@ -1 +1 @@\n-a\n+Subproject commit 2222222222222222222222222222222222222222` })).toEqual(["git", "release"]);
    });

    it("a new 100755 mode is shell, including mode-only changes and extensionless scripts", () => {
      expect(cats({ diff: "diff --git a/tools/run b/tools/run\nold mode 100644\nnew mode 100755" })).toEqual(["shell"]);
      const script = "diff --git a/tools/run b/tools/run\nnew file mode 100755\nindex 0000000..1111111\n--- /dev/null\n+++ b/tools/run\n@@ -0,0 +1,2 @@\n+#!/bin/sh\n+node ./dist/x.js";
      expect(cats({ diff: script })).toEqual(["shell"]);
      expect(classifyRisk({ diff: "diff --git a/tools/run b/tools/run\nold mode 100755\nnew mode 100644" }).level).toBe("normal");
    });
  });

  describe("binary content", () => {
    const bin = (file: string, mode = "100644") =>
      `diff --git a/${file} b/${file}\nnew file mode ${mode}\nindex 0000000..d00491f\nGIT binary patch\nliteral 12\nzcmZ?wbhEHbWMp7uXkcIfg8\n\nliteral 0\nHcmV?d00001\n`;

    it("is unscanned unless it is non-executable media", () => {
      expect(cats({ diff: bin("assets/x.bin") })).toEqual([RISK_UNSCANNED]);
      expect(cats({ diff: bin("tools/helper") })).toEqual([RISK_UNSCANNED]);
      for (const ext of ["png", "JPG", "jpeg", "gif", "webp", "ico", "pdf", "woff", "woff2", "ttf"]) {
        expect(classifyRisk({ diff: bin(`assets/a.${ext}`) }).level, ext).toBe("normal");
      }
      expect(cats({ diff: bin("assets/logo.png", "100755") })).toEqual(["shell", RISK_UNSCANNED]);
    });

    it("applies to `Binary files … differ` too", () => {
      const noext = "diff --git a/tools/helper b/tools/helper\nnew file mode 100755\nindex 0000000..abc\nBinary files /dev/null and b/tools/helper differ";
      expect(cats({ diff: noext })).toEqual(["shell", RISK_UNSCANNED]);
      expect(cats({ diff: "Binary files a/docs/a.svg and b/docs/a.svg differ" })).toEqual([RISK_UNSCANNED]);
      expect(classifyRisk({ diff: "Binary files a/docs/a.png and b/docs/a.png differ" }).level).toBe("normal");
    });
  });

  describe("context lines", () => {
    it("catches `shell: false` turned on next to a spawn in the context", () => {
      const diff = `${hdr("src/util/run.ts")}@@ -10,4 +10,4 @@ export function runAgent(bin: string) {\n   const child = spawn(bin, args, {\n-    shell: false,\n+    shell: process.platform === "win32",\n     stdio: "pipe",`;
      expect(cats({ diff })).toEqual(expect.arrayContaining(["process", "shell"]));
    });

    it("catches an execFileSync argument swap where only the arguments change", () => {
      const diff = `${hdr("src/util/run.ts")}@@ -10,4 +10,4 @@\n   execFileSync(bin, [\n-    "--safe",\n+    userArg,\n   ]);`;
      expect(cats({ diff })).toContain("process");
    });

    it("scans the function context after `@@ … @@`", () => {
      const diff = `${hdr("src/util/run.ts")}@@ -10,2 +10,2 @@ function spawnAgent() { return spawn(bin, [\n-  "a",\n+  "b",`;
      const result = classifyRisk({ diff });
      expect(result.categories).toContain("process");
      expect(result.reasons.join("\n")).toContain("hunk header");
    });
  });

  describe("keywords", () => {
    const changed = (line: string) => cats({ diff: `${hdr(NORMAL_FILE)}@@ -1,1 +1,1 @@\n-x\n+${line}` });

    it("read-only flags in any spelling, but not the TypeScript `readonly` keyword", () => {
      for (const line of ["this.readOnly = false;", "if (seat.isReadOnly) return;", "mode: READ_ONLY", "a read-only seat", "READONLY"]) {
        expect(changed(line), line).toContain("permissions");
      }
      expect(changed("readonly sessionId: string;")).toEqual([]);
    });

    it("permissions:, approvals, autopilot and autonomy", () => {
      for (const line of ['permissions: "edit",', "await requestApproval(stage);", 'return "autopilot";', 'autonomy: "full"']) {
        expect(changed(line), line).toContain("permissions");
      }
    });

    it("`shell:` with any value", () => {
      for (const line of ["{ shell: useShell }", "{ shell: isWin }", 'shell: "/bin/zsh"']) {
        expect(changed(line), line).toContain("shell");
      }
    });

    it("dynamic loading", () => {
      expect(changed("const mod = await import(pathToFileURL(userPath).href);")).toContain("shell");
      expect(changed("const r = require(name);")).toContain("shell");
      expect(changed("const r = require('node:child_' + 'process');")).toContain("shell");
      expect(changed("const req = createRequire(import.meta.url);")).toContain("shell");
      expect(changed("vm.createContext(sandbox);")).toContain("shell");
      expect(changed("new Worker(file, { eval: false });")).toContain("process");
      expect(changed("process.dlopen(module, file);")).toContain("process");
      expect(changed("process['\\x6bill'](pid);")).toContain("process");
      expect(changed('const x = await import("./x.js");')).toEqual([]);
      expect(changed('const y = require("./y.js");')).toEqual([]);
    });

    it("host binds, guarded readers and timing-safe compares", () => {
      expect(changed('host: "::",')).toContain("network");
      expect(changed('host: "0.0.0.0",')).toContain("network");
      expect(changed("const t = await readGuardedProjectText(root, rel);")).toContain("paths");
      expect(changed("if (!timingSafeEqual(a, b)) return false;")).toContain("secrets");
    });
  });

  describe("bare names match with an extension", () => {
    const cases: Array<[string, string]> = [
      ["src/keys.ts", "secrets"],
      ["src/tui/screens/keys.tsx", "secrets"],
      ["config.json", "config"],
      ["src/config.ts", "config"],
      ["src/utils/process.ts", "process"],
      ["src/git.ts", "git"],
      ["lib/serve.ts", "network"],
    ];
    for (const [p, category] of cases) {
      it(`${p} → ${category}`, () => expect(cats({ paths: [p] })).toContain(category));
    }
  });

  describe("unicode", () => {
    for (const p of ["src/proce\u017F\u017F/kill-tree.ts", "src/pro\u200Ccess/kill-tree.ts", "src/pro\u200Bcess/kill-tree.ts", "src/process\u00AD/x.ts", "src/process\u2060/x.ts", "src/\u212Aeys/vault.ts", "src/proc\uFF45ss/x.ts", "\uFEFFsrc/git/a.ts"]) {
      it(`path ${JSON.stringify(p)} is still matched`, () => expect(classifyRisk({ paths: [p] }).level).toBe("danger"));
    }

    it("task text and diff content are normalised too", () => {
      expect(cats({ taskText: "spa\u200Bwn the child pro\u200Bcess" })).toContain("process");
      expect(cats({ diff: `${hdr(NORMAL_FILE)}@@ -1 +1 @@\n-x\n+const c = spa\u200Dwn(cmd);` })).toContain("process");
      expect(cats({ diff: `${hdr(NORMAL_FILE)}@@ -1 +1 @@\n-x\n+--dangerously\u00AD-skip-permissions` })).toContain("permissions");
    });

    it("strips bidi and invisible marks from reasons", () => {
      const result = classifyRisk({ taskText: "kill the process \u200E\u200F\u061C\u202E" , paths: ["src/process/a\u200E.ts"] });
      expect(result.reasons.join("\n")).not.toMatch(/[\u200E\u200F\u061C\u202E]/);
    });
  });

  describe("caps and unreadable diffs", () => {
    it("a path over 64 segments or 1024 chars is unscanned", () => {
      expect(cats({ paths: ["a/".repeat(64) + "b"] })).toEqual([RISK_UNSCANNED]);
      expect(classifyRisk({ paths: ["a/".repeat(63) + "b"] }).level).toBe("normal");
      expect(cats({ paths: ["a".repeat(MAX_RISK_PATH_CHARS + 1)] })).toEqual([RISK_UNSCANNED]);
    });

    it("a context diff (`diff -c`) is unscanned", () => {
      const diff = "*** src/util/a.ts\n--- src/util/a.ts\n***************\n*** 1 ****\n! x\n--- 1 ----\n! execSync(userCmd)";
      expect(cats({ diff })).toContain(RISK_UNSCANNED);
    });

    it("a combined diff hunk is unscanned", () => {
      const diff = "diff --cc src/util/a.ts\nindex 1,2..3\n--- a/src/util/a.ts\n+++ b/src/util/a.ts\n@@@ -1,1 -1,1 +1,2 @@@\n  x\n +spawn(cmd, { shell: true })";
      expect(cats({ diff })).toContain(RISK_UNSCANNED);
    });

    it("recognised headers without hunks stay readable (pure rename, mode, similarity)", () => {
      const rename = "diff --git a/src/util/a.ts b/src/util/b.ts\nsimilarity index 100%\nrename from src/util/a.ts\nrename to src/util/b.ts";
      expect(classifyRisk({ diff: rename }).level).toBe("normal");
      expect(classifyRisk({ diff: "diff --git a/a.ts b/a.ts\ndeleted file mode 100644\nindex 1111111..0000000" }).level).toBe("normal");
    });
  });

  describe("extra build and tooling files", () => {
    const cases: Array<[string, string]> = [
      [".pnpmfile.cjs", "release"],
      ["setup.py", "release"],
      ["build.rs", "release"],
      ["vite.config.ts", "release"],
      [".vscode/tasks.json", "shell"],
      [".devcontainer/devcontainer.json", "shell"],
      ["tools/deploy", "release"],
      ["src/modes/danger.ts", "permissions"],
    ];
    for (const [p, category] of cases) {
      it(`${p} → ${category}`, () => expect(cats({ paths: [p] })).toContain(category));
    }
  });
});
