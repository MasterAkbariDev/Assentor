import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { LocalGitService } from "../git/local.js";
import { redactSecrets } from "../security/redact.js";
import {
  buildDirectoryTree,
  searchProject,
  SKIP_DIRS,
} from "../artifacts/evidence.js";
import { ArtifactCollector } from "../artifacts/collector.js";
import { ArtifactType } from "../artifacts/types.js";
import {
  emptyEvidencePack,
  type EvidenceFileRef,
  type ProjectReviewEvidencePack,
  type RunStatusMarker,
} from "./evidence-pack.js";
import { saveEvidencePack } from "./persist.js";
import type { EvidenceRequestItem } from "../protocol/messages.js";
import { fulfillEvidenceRequests } from "../artifacts/evidence.js";
import type { ExecutorResult } from "../providers/executors/types.js";
import type { TaskContract } from "../core/task-contract.js";

const MAX_FILE_BYTES = 80_000;
const MAX_FILES = 24;
const MAX_DIFF_CHARS = 60_000;

export interface EvidencePackBuilderOptions {
  projectPath: string;
  taskId?: string;
  round?: number;
  depth?: ProjectReviewEvidencePack["depth"];
  contract?: TaskContract;
  /** When false, skip running test/lint/typecheck (record NOT_RUN). Default true for STANDARD/DEEP. */
  runCommands?: boolean;
  collector?: ArtifactCollector;
  /** Git HEAD at task start so committed executor work still shows as changed. */
  gitBaselineHead?: string | null;
}

/**
 * Builds a Project Review Evidence Pack using local deterministic tools.
 * Never invents missing evidence — uses NOT_RUN / missing markers.
 */
export class EvidencePackBuilder {
  private readonly projectPath: string;
  private readonly collector: ArtifactCollector;

  constructor(private readonly options: EvidencePackBuilderOptions) {
    this.projectPath = path.resolve(options.projectPath);
    this.collector = options.collector ?? new ArtifactCollector();
  }

  getCollector(): ArtifactCollector {
    return this.collector;
  }

  async build(
    extras: {
      executorResult?: ExecutorResult;
      executorExplanation?: ProjectReviewEvidencePack["executorExplanation"];
      architecture?: ProjectReviewEvidencePack["architecture"];
    } = {},
  ): Promise<ProjectReviewEvidencePack> {
    const pack = emptyEvidencePack(this.projectPath, {
      taskId: this.options.taskId,
      round: this.options.round ?? 0,
      depth: this.options.depth ?? "STANDARD",
    });

    pack.overview = await this.detectOverview();
    pack.structure = await this.buildStructure();
    pack.git = await this.collectGit();
    pack.dependencies = await this.collectDependencies();
    pack.configuration = await this.collectConfigHints();

    const claimed: string[] = [];
    for (const relative of claimedPathsFromExecutor(extras)) {
      try {
        await fs.access(path.join(this.projectPath, relative));
        claimed.push(relative);
      } catch {
        // named but not on disk
      }
    }
    const changed = uniquePaths([...pack.git.changedFiles, ...claimed]);
    if (claimed.length > 0 && pack.git.changedFiles.length === 0) {
      pack.git.changedFiles = changed;
      pack.git.note = joinNotes(
        pack.git.note,
        "Working tree had no dirty files; included paths named in the executor response.",
      );
    } else if (claimed.some((p) => !pack.git.changedFiles.includes(p))) {
      pack.git.changedFiles = changed;
    }

    const relevant = await this.selectRelevantFiles(changed);
    pack.relevantFiles = relevant.changed;
    pack.unchangedImportant = relevant.unchanged;

    const shouldRun =
      this.options.runCommands ??
      (pack.depth === "STANDARD" || pack.depth === "DEEP");
    pack.tests = await this.collectCommandStatus(shouldRun && pack.depth === "DEEP");

    if (extras.architecture) {
      pack.architecture = extras.architecture;
    } else {
      pack.architecture = {
        summary: "",
        modules: [],
        boundaries: [],
        abstractions: [],
        source: "missing",
      };
    }

    if (extras.executorExplanation) {
      pack.executorExplanation = extras.executorExplanation;
    }

    if (extras.executorResult) {
      pack.notes.push(
        `Executor status: ${extras.executorResult.status} — ${extras.executorResult.summary}`,
      );
      if (!pack.executorExplanation.raw && extras.executorResult.rawOutput) {
        pack.executorExplanation = {
          ...pack.executorExplanation,
          raw: extras.executorResult.rawOutput.slice(0, 8_000),
          source: pack.executorExplanation.source === "missing"
            ? "missing"
            : pack.executorExplanation.source,
        };
      }
    }

    this.syncCollector(pack);
    return pack;
  }

  async mergeRequests(
    pack: ProjectReviewEvidencePack,
    requests: EvidenceRequestItem[],
  ): Promise<{
    pack: ProjectReviewEvidencePack;
    fulfilled: number;
    skipped: number;
    errors: string[];
    remaining: EvidenceRequestItem[];
  }> {
    const git = new LocalGitService({ cwd: this.projectPath });
    const result = await fulfillEvidenceRequests(requests, {
      projectPath: this.projectPath,
      collector: this.collector,
      git: (await git.isRepo()) ? git : undefined,
      runCommand: runShellCommand,
    });

    const remaining: EvidenceRequestItem[] = [];
    let idx = 0;
    for (const request of requests) {
      // Rough: if we had errors or skips, keep architecture/runtime for executor
      const needsExecutor =
        request.kind === "architecture" ||
        request.kind === "runtime_information" ||
        request.kind === "screenshot" ||
        request.kind === "environment" ||
        request.kind === "scene_hierarchy" ||
        request.kind === "mcp_inspection";
      if (needsExecutor) {
        remaining.push(request);
      }
      idx += 1;
    }
    void idx;

    // Fold newly collected file artifacts into pack
    for (const artifact of this.collector.list({ type: "file" })) {
      if (!artifact.path || !artifact.content) continue;
      const exists = pack.relevantFiles.some((f) => f.path === artifact.path);
      if (!exists) {
        pack.relevantFiles.push({
          path: artifact.path,
          role: "relevant",
          description: artifact.description,
          content: artifact.content.slice(0, MAX_FILE_BYTES),
          truncated: artifact.content.length > MAX_FILE_BYTES,
        });
      }
    }

    for (const artifact of this.collector.list()) {
      if (artifact.metadata?.kind === "search" || artifact.description?.includes("search")) {
        pack.notes.push(
          `Search evidence: ${artifact.description}\n${(artifact.content ?? "").slice(0, 2000)}`,
        );
      }
    }

    pack.updatedAt = new Date().toISOString();
    return {
      pack,
      fulfilled: result.fulfilled,
      skipped: result.skipped,
      errors: result.errors,
      remaining,
    };
  }

  async persist(pack: ProjectReviewEvidencePack, taskId: string): Promise<void> {
    await saveEvidencePack(pack, taskId);
  }

  private syncCollector(pack: ProjectReviewEvidencePack): void {
    this.collector.clear();
    if (pack.git.status) {
      this.collector.addGitStatus(pack.git.status);
    }
    if (pack.git.diff) {
      this.collector.addGitDiff(pack.git.diff);
    }
    if (pack.git.changedFiles.length) {
      this.collector.addChangedFiles(pack.git.changedFiles);
    }
    if (pack.structure.tree) {
      this.collector.add({
        type: ArtifactType.ProjectStructure,
        description: "project structure",
        content: pack.structure.tree,
      });
    }
    for (const file of [...pack.relevantFiles, ...pack.unchangedImportant]) {
      if (file.content) {
        this.collector.addFile(
          file.path,
          file.content,
          file.description ?? `${file.role}: ${file.path}`,
        );
      }
    }
    if (pack.executorExplanation.raw || pack.executorExplanation.whatChanged) {
      this.collector.add({
        type: ArtifactType.Other,
        description: "executor explanation",
        content:
          pack.executorExplanation.whatChanged ??
          pack.executorExplanation.raw ??
          "",
      });
    }
    if (pack.architecture.summary) {
      this.collector.add({
        type: ArtifactType.Other,
        description: "architecture summary",
        content: pack.architecture.summary,
      });
    }
  }

  private async detectOverview(): Promise<ProjectReviewEvidencePack["overview"]> {
    const overview: ProjectReviewEvidencePack["overview"] = {
      linting: [],
      majorDependencies: [],
    };

    const pkgPath = path.join(this.projectPath, "package.json");
    try {
      const raw = await fs.readFile(pkgPath, "utf8");
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      overview.projectType = "node";
      overview.language = "javascript/typescript";
      overview.runtime = "node";
      const deps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      overview.majorDependencies = Object.keys(deps).slice(0, 30);
      if (deps.react || deps["react-dom"]) overview.framework = "react";
      if (deps.svelte || deps["@sveltejs/kit"]) overview.framework = "svelte";
      if (deps.next) overview.framework = "next";
      if (deps.vitest || deps.jest || deps.mocha) {
        overview.testFramework = deps.vitest
          ? "vitest"
          : deps.jest
            ? "jest"
            : "mocha";
      }
      if (deps.eslint) overview.linting.push("eslint");
      if (deps.typescript) overview.language = "typescript";
      overview.buildSystem = pkg.scripts?.build ? "npm scripts" : undefined;
    } catch {
      // not a node project
    }

    for (const [lock, pm] of [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
      ["bun.lockb", "bun"],
    ] as const) {
      try {
        await fs.access(path.join(this.projectPath, lock));
        overview.packageManager = pm;
        break;
      } catch {
        // continue
      }
    }

    try {
      await fs.access(path.join(this.projectPath, "Cargo.toml"));
      overview.projectType = "rust";
      overview.language = "rust";
      overview.buildSystem = "cargo";
    } catch {
      // ignore
    }

    try {
      await fs.access(path.join(this.projectPath, "go.mod"));
      overview.projectType = "go";
      overview.language = "go";
    } catch {
      // ignore
    }

    try {
      await fs.access(path.join(this.projectPath, "pyproject.toml"));
      overview.projectType = "python";
      overview.language = "python";
    } catch {
      // ignore
    }

    return overview;
  }

  private async buildStructure(): Promise<ProjectReviewEvidencePack["structure"]> {
    const tree = await buildDirectoryTree(this.projectPath, ".", 3);
    let rootFiles: string[] = [];
    try {
      rootFiles = (await fs.readdir(this.projectPath)).filter(
        (n) => !SKIP_DIRS.has(n) && !n.startsWith("."),
      );
    } catch {
      rootFiles = [];
    }
    return {
      tree,
      rootFiles,
      omitted: [...SKIP_DIRS],
    };
  }

  private async collectGit(): Promise<ProjectReviewEvidencePack["git"]> {
    const gitInfo: ProjectReviewEvidencePack["git"] = {
      isRepo: false,
      changedFiles: [],
    };
    try {
      const git = new LocalGitService({ cwd: this.projectPath });
      if (!(await git.isRepo())) {
        return gitInfo;
      }
      gitInfo.isRepo = true;
      const status = await git.status();
      gitInfo.branch = status.branch ?? undefined;
      gitInfo.commit = status.head ?? undefined;
      gitInfo.status = status.porcelain;
      gitInfo.workingTreeClean = !status.dirty;
      const baseline = this.options.gitBaselineHead?.trim() || undefined;
      if (baseline) {
        gitInfo.baselineCommit = baseline;
      }

      const since = await git.changesSince(baseline);
      const changed = since.files.filter((f) => !isNoisePath(f));
      gitInfo.changedFiles = changed;
      let diff = since.diff;
      if (diff.length > MAX_DIFF_CHARS) {
        diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n…[truncated]`;
      }
      gitInfo.diff = redactSecrets(diff).text;

      if (baseline && gitInfo.workingTreeClean && changed.length > 0) {
        gitInfo.note =
          "Working tree is clean; files listed changed in commits since task start. That is valid evidence — do not ask to git add/commit.";
      } else if (gitInfo.workingTreeClean && changed.length === 0) {
        gitInfo.note =
          "No git diff since task start (working tree clean). Check file contents and executor claims before assuming nothing changed.";
      }

      try {
        const logArgs = baseline
          ? ["log", "-n", "8", "--oneline", `${baseline}..HEAD`]
          : ["log", "-n", "8", "--oneline"];
        const log = await runGit(this.projectPath, logArgs);
        gitInfo.recentLog = log;
      } catch {
        // optional
      }
    } catch {
      // git optional
    }
    return gitInfo;
  }

  private async collectDependencies(): Promise<
    ProjectReviewEvidencePack["dependencies"]
  > {
    const info: ProjectReviewEvidencePack["dependencies"] = {
      scripts: {},
      relevantConfigPaths: [],
      configExcerpts: [],
    };
    const pkgPath = path.join(this.projectPath, "package.json");
    try {
      const raw = await fs.readFile(pkgPath, "utf8");
      const redacted = redactSecrets(raw);
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
      info.manifestPath = "package.json";
      info.manifestExcerpt = redacted.text.slice(0, 4_000);
      info.scripts = pkg.scripts ?? {};
    } catch {
      // ignore
    }

    for (const cfg of [
      "tsconfig.json",
      "vitest.config.ts",
      "vite.config.ts",
      ".eslintrc.cjs",
      "eslint.config.js",
    ]) {
      try {
        const abs = path.join(this.projectPath, cfg);
        const raw = await fs.readFile(abs, "utf8");
        info.relevantConfigPaths.push(cfg);
        info.configExcerpts.push({
          path: cfg,
          content: redactSecrets(raw).text.slice(0, 3_000),
        });
      } catch {
        // skip
      }
    }
    return info;
  }

  private async collectConfigHints(): Promise<
    ProjectReviewEvidencePack["configuration"]
  > {
    const envVarNames: string[] = [];
    const configPaths: string[] = [];
    for (const name of [".env.example", ".env.sample"]) {
      try {
        const raw = await fs.readFile(
          path.join(this.projectPath, name),
          "utf8",
        );
        configPaths.push(name);
        for (const line of raw.split("\n")) {
          const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
          if (m?.[1]) envVarNames.push(m[1]);
        }
      } catch {
        // skip
      }
    }
    return {
      envVarNames,
      featureFlags: [],
      configPaths,
      notes: "Secret values are never included — names/paths only.",
    };
  }

  private async selectRelevantFiles(changed: string[]): Promise<{
    changed: EvidenceFileRef[];
    unchanged: EvidenceFileRef[];
  }> {
    const candidates = new Set<string>();
    for (const f of changed) {
      if (!isNoisePath(f)) candidates.add(f);
    }

    const contract = this.options.contract;
    if (contract) {
      const blobs = [
        contract.goal,
        ...contract.requirements,
        ...contract.acceptanceCriteria,
        ...contract.verificationPlan,
      ];
      for (const text of blobs) {
        const matches = text.match(
          /([A-Za-z0-9_./-]+\.(?:html|css|js|ts|tsx|jsx|json|md|py|go|rs|java))/g,
        );
        for (const m of matches ?? []) {
          candidates.add(m.replace(/^\.\//, ""));
        }
      }
    }

    for (const name of [
      "package.json",
      "README.md",
      "index.html",
      "src/index.ts",
      "src/main.ts",
      "src/app.ts",
    ]) {
      candidates.add(name);
    }

    // Import heuristic from changed files
    for (const file of changed.slice(0, 12)) {
      try {
        const content = await fs.readFile(
          path.join(this.projectPath, file),
          "utf8",
        );
        const imports = content.matchAll(
          /from\s+['"](\.[^'"]+)['"]|require\(['"](\.[^'"]+)['"]\)/g,
        );
        for (const match of imports) {
          const rel = match[1] ?? match[2];
          if (!rel) continue;
          const resolved = resolveImport(file, rel);
          if (resolved) candidates.add(resolved);
        }
      } catch {
        // skip
      }
    }

    const changedSet = new Set(changed);
    const changedRefs: EvidenceFileRef[] = [];
    const unchangedRefs: EvidenceFileRef[] = [];

    for (const relative of [...candidates].sort()) {
      if (isNoisePath(relative)) continue;
      if (changedRefs.length + unchangedRefs.length >= MAX_FILES) break;
      const ref = await this.readFileRef(
        relative,
        changedSet.has(relative) ? "changed" : "unchanged_important",
      );
      if (!ref) continue;
      if (changedSet.has(relative)) changedRefs.push(ref);
      else unchangedRefs.push(ref);
    }

    // Caller search for first changed basename
    if (changed[0]) {
      const base = path.basename(changed[0]).replace(/\.[^.]+$/, "");
      if (base.length > 2) {
        try {
          const hits = await searchProject(this.projectPath, base, 15);
          if (hits) {
            this.collector.add({
              type: ArtifactType.Other,
              description: `callers/search for ${base}`,
              content: hits,
              metadata: { kind: "search", query: base },
            });
          }
        } catch {
          // ignore
        }
      }
    }

    return { changed: changedRefs, unchanged: unchangedRefs };
  }

  private async readFileRef(
    relative: string,
    role: EvidenceFileRef["role"],
  ): Promise<EvidenceFileRef | null> {
    const absolute = path.join(this.projectPath, relative);
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size > 200_000) return null;
      const raw = await fs.readFile(absolute, "utf8");
      const redacted = redactSecrets(raw);
      const truncated = redacted.text.length > MAX_FILE_BYTES;
      return {
        path: relative,
        role,
        description: `${role}: ${relative}`,
        content: redacted.text.slice(0, MAX_FILE_BYTES),
        truncated,
      };
    } catch {
      return null;
    }
  }

  private async collectCommandStatus(
    run: boolean,
  ): Promise<ProjectReviewEvidencePack["tests"]> {
    const notRun = (cmd?: string) => ({
      status: "NOT_RUN" as RunStatusMarker,
      command: cmd,
    });
    if (!run) {
      return {
        relevantTests: [],
        test: notRun("npm test"),
        build: notRun("npm run build"),
        lint: notRun("npm run lint"),
        typecheck: notRun("npx tsc --noEmit"),
      };
    }

    return {
      relevantTests: [],
      test: await tryCommand(this.projectPath, "npm test"),
      build: await tryCommand(this.projectPath, "npm run build"),
      lint: await tryCommand(this.projectPath, "npm run lint"),
      typecheck: await tryCommand(this.projectPath, "npx tsc --noEmit"),
    };
  }
}

export function parseExecutorExplanation(
  text: string,
): ProjectReviewEvidencePack["executorExplanation"] {
  const trimmed = text.trim();
  try {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      return {
        whatChanged: String(parsed.whatChanged ?? parsed.what_changed ?? ""),
        why: String(parsed.why ?? ""),
        assumptions: Array.isArray(parsed.assumptions)
          ? parsed.assumptions.map(String)
          : [],
        unchanged: String(parsed.unchanged ?? ""),
        risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
        limitations: Array.isArray(parsed.limitations)
          ? parsed.limitations.map(String)
          : [],
        raw: trimmed.slice(0, 12_000),
        source: "executor",
      };
    }
  } catch {
    // fall through
  }
  return {
    whatChanged: trimmed.slice(0, 4_000),
    why: undefined,
    assumptions: [],
    unchanged: undefined,
    risks: [],
    limitations: [],
    raw: trimmed.slice(0, 12_000),
    source: "executor",
  };
}

export const EXPLANATION_PROMPT = [
  "Provide a brief architecture summary and implementation explanation for the changes you just made.",
  "Do NOT edit files. Reply with JSON only:",
  JSON.stringify(
    {
      architectureSummary: "how modules relate",
      whatChanged: "files and behavior",
      why: "rationale",
      assumptions: ["..."],
      unchanged: "what you left alone and why it matters",
      risks: ["..."],
      limitations: ["..."],
    },
    null,
    2,
  ),
].join("\n");

function resolveImport(fromFile: string, spec: string): string | null {
  const dir = path.dirname(fromFile);
  let resolved = path.normalize(path.join(dir, spec)).replace(/\\/g, "/");
  if (resolved.startsWith("../") || resolved.includes("node_modules")) {
    return null;
  }
  if (!path.extname(resolved)) {
    // Prefer .ts then .js
    return `${resolved}.ts`;
  }
  return resolved;
}

function isNoisePath(relative: string): boolean {
  const normalized = relative.replace(/\\/g, "/");
  return (
    normalized === ".assentor" ||
    normalized.startsWith(".assentor/") ||
    normalized.startsWith("node_modules/") ||
    normalized.startsWith(".git/") ||
    normalized.endsWith(".map") ||
    [...SKIP_DIRS].some(
      (d) => normalized === d || normalized.startsWith(`${d}/`),
    )
  );
}

/** Paths like `src/ai/minimax.js` mentioned in executor text. */
export function extractClaimedSourcePaths(text: string): string[] {
  const found = new Set<string>();
  const re =
    /(?:^|[\s`'"(])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z][A-Za-z0-9]*)/g;
  for (const match of text.matchAll(re)) {
    const p = (match[1] ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (p && !isNoisePath(p)) {
      found.add(p);
    }
  }
  return [...found];
}

function claimedPathsFromExecutor(extras: {
  executorResult?: ExecutorResult;
  executorExplanation?: ProjectReviewEvidencePack["executorExplanation"];
}): string[] {
  const blobs = [
    extras.executorResult?.summary,
    extras.executorResult?.rawOutput,
    extras.executorExplanation?.whatChanged,
    extras.executorExplanation?.raw,
  ];
  const found = new Set<string>();
  for (const blob of blobs) {
    if (!blob) {
      continue;
    }
    for (const p of extractClaimedSourcePaths(blob)) {
      found.add(p);
    }
  }
  return [...found];
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

function joinNotes(existing: string | undefined, extra: string): string {
  return existing ? `${existing} ${extra}` : extra;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (err += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err || `git failed`));
    });
  });
}

async function runShellCommand(
  command: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (error) => {
      resolve({ stdout, stderr: error.message, code: 1 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

async function tryCommand(
  cwd: string,
  command: string,
): Promise<{
  status: RunStatusMarker;
  command: string;
  output?: string;
  exitCode?: number;
}> {
  try {
    const result = await runShellCommand(command, cwd);
    const redacted = redactSecrets(
      [result.stdout, result.stderr].filter(Boolean).join("\n"),
    );
    return {
      status: result.code === 0 ? "PASSED" : "FAILED",
      command,
      output: redacted.text.slice(0, 8_000),
      exitCode: result.code,
    };
  } catch (error) {
    return {
      status: "FAILED",
      command,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}
