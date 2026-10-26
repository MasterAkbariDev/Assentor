import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { LocalGitService } from "../git/local.js";
import { redactSecrets } from "../security/redact.js";
import { readGuardedProjectText } from "../security/paths.js";
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
import {
  detectVerificationCommands,
  emptyVerificationCommands,
  type VerificationCommands,
} from "../config/detect-commands.js";
import { fulfillEvidenceRequests } from "../artifacts/evidence.js";
import {
  isImagePath,
  readProjectImageBase64,
} from "../artifacts/images.js";
import type { ExecutorResult } from "../providers/executors/types.js";
import type { TaskContract } from "../core/task-contract.js";
import { runShellCommand } from "../process/run-shell.js";

const MAX_FILE_BYTES = 80_000;
const MAX_FILES = 24;
const MAX_FILES_DEEP = 40;
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
  /** Configured/detected project commands for test/lint/typecheck/build. */
  verificationCommands?: VerificationCommands;
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

    if (extras.architecture?.summary) {
      pack.architecture = extras.architecture;
    } else {
      const goalText = this.options.contract?.goal ?? "";
      let summary =
        extras.architecture?.summary ??
        parseArchitectureSummary(
          extras.executorExplanation?.raw ??
            extras.executorExplanation?.whatChanged ??
            "",
        ) ??
        "";

      if (!summary && isArchitectureHeavyTask(goalText)) {
        summary = (await loadProjectArchitectureDoc(this.projectPath)) ?? "";
      }

      const architectureSource = extras.architecture?.source
        ?? (summary
          ? parseArchitectureSummary(
              extras.executorExplanation?.raw ??
                extras.executorExplanation?.whatChanged ??
                "",
            )
            ? "executor"
            : "assentor"
          : "missing");

      pack.architecture = summary
        ? {
            summary,
            modules: extras.architecture?.modules ?? [],
            boundaries: extras.architecture?.boundaries ?? [],
            abstractions: extras.architecture?.abstractions ?? [],
            source: architectureSource,
          }
        : {
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
    await this.collectScreenshotArtifacts();
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
    unfulfilled: EvidenceRequestItem[];
  }> {
    const git = new LocalGitService({ cwd: this.projectPath });
    const commands = await this.resolveCommands();
    const result = await fulfillEvidenceRequests(requests, {
      projectPath: this.projectPath,
      collector: this.collector,
      git: (await git.isRepo()) ? git : undefined,
      runCommand: runShellCommand,
      verificationCommands: commands,
      architectureFallback: pack.architecture.summary || undefined,
    });

    if (!pack.architecture.summary) {
      const doc = await loadProjectArchitectureDoc(this.projectPath);
      if (doc) {
        pack.architecture = {
          summary: doc,
          modules: pack.architecture.modules ?? [],
          boundaries: pack.architecture.boundaries ?? [],
          abstractions: pack.architecture.abstractions ?? [],
          source: "assentor",
        };
      }
    }

    for (const artifact of this.collector.list()) {
      if (
        artifact.description === "architecture summary" &&
        artifact.content &&
        !pack.architecture.summary
      ) {
        pack.architecture = {
          summary: artifact.content.slice(0, 12_000),
          modules: pack.architecture.modules ?? [],
          boundaries: pack.architecture.boundaries ?? [],
          abstractions: pack.architecture.abstractions ?? [],
          source: "assentor",
        };
      }
    }

    for (const request of result.unfulfilled) {
      pack.notes.push(formatUnfulfilledEvidenceNote(request));
    }

    // Fold requested files into the front of the pack so the prompt's file
    // limit and evidence budget reach them before older context.
    const requestedFiles = this.collector
      .list({ type: "file" })
      .filter((artifact) => artifact.path && artifact.content);
    const requestedPaths = new Set(requestedFiles.map((a) => a.path));
    pack.relevantFiles = [
      ...requestedFiles.map((artifact) => ({
        path: artifact.path!,
        role: "relevant" as const,
        description: artifact.description,
        content: artifact.content!.slice(0, MAX_FILE_BYTES),
        truncated: artifact.content!.length > MAX_FILE_BYTES,
      })),
      ...pack.relevantFiles.filter((f) => !requestedPaths.has(f.path)),
    ];

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
      unfulfilled: result.unfulfilled,
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
          /([A-Za-z0-9_./-]+\.(?:html|css|js|ts|tsx|jsx|json|md|py|go|rs|java|dart))/g,
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
      ...ARCHITECTURE_DOC_CANDIDATES,
    ]) {
      candidates.add(name);
    }

    if (
      isArchitectureHeavyTask(
        [
          contract?.goal ?? "",
          ...(contract?.requirements ?? []),
          ...(contract?.acceptanceCriteria ?? []),
        ].join("\n"),
      )
    ) {
      for (const doc of ARCHITECTURE_DOC_CANDIDATES) {
        candidates.add(doc);
      }
      for (const related of expandRelatedModuleFiles(changed)) {
        candidates.add(related);
      }
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

    const orderedCandidates = [
      ...changed.filter((file) => candidates.has(file)),
      ...[...candidates].filter((file) => !changedSet.has(file)).sort(),
    ];

    const maxFiles =
      this.options.depth === "DEEP" ? MAX_FILES_DEEP : MAX_FILES;

    for (const relative of orderedCandidates) {
      if (isNoisePath(relative)) continue;
      if (changedRefs.length + unchangedRefs.length >= maxFiles) break;
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
    if (isImagePath(relative)) {
      return null;
    }
    const text = (await readGuardedProjectText(this.projectPath, relative))?.text;
    if (text === undefined) return null;
    const truncated = text.length > MAX_FILE_BYTES;
    return {
      path: relative,
      role,
      description: `${role}: ${relative}`,
      content: text.slice(0, MAX_FILE_BYTES),
      truncated,
    };
  }

  private async collectScreenshotArtifacts(): Promise<void> {
    const dirs = ["artifacts/screenshots"];
    if (this.options.taskId) {
      dirs.push(
        path.join(
          ".assentor",
          "tasks",
          this.options.taskId,
          "artifacts",
          "screenshots",
        ),
      );
    }

    const seen = new Set(
      this.collector
        .list({ type: ArtifactType.Screenshot })
        .map((artifact) => artifact.path)
        .filter(Boolean) as string[],
    );

    for (const relativeDir of dirs) {
      const absoluteDir = path.join(this.projectPath, relativeDir);
      let entries: string[];
      try {
        entries = await fs.readdir(absoluteDir);
      } catch {
        continue;
      }
      for (const name of entries.sort()) {
        const relative = path.join(relativeDir, name).replace(/\\/g, "/");
        if (!isImagePath(relative) || seen.has(relative)) {
          continue;
        }
        try {
          const image = await readProjectImageBase64(this.projectPath, relative);
          this.collector.add({
            type: ArtifactType.Screenshot,
            path: relative,
            description: `terminal screenshot: ${name}`,
            content: image.data,
            metadata: {
              mimeType: image.mimeType,
              encoding: "base64",
            },
          });
          seen.add(relative);
        } catch {
          // skip unreadable images
        }
      }
    }
  }

  private async collectCommandStatus(
    run: boolean,
  ): Promise<ProjectReviewEvidencePack["tests"]> {
    const commands = await this.resolveCommands();
    const notRun = (cmd?: string) => ({
      status: "NOT_RUN" as RunStatusMarker,
      command: cmd || undefined,
    });
    if (!run) {
      return {
        relevantTests: [],
        test: notRun(commands.test),
        build: notRun(commands.build),
        lint: notRun(commands.lint),
        typecheck: notRun(commands.typecheck),
      };
    }

    return {
      relevantTests: [],
      test: commands.test
        ? await tryCommand(this.projectPath, commands.test)
        : notRun(),
      build: commands.build
        ? await tryCommand(this.projectPath, commands.build)
        : notRun(),
      lint: commands.lint
        ? await tryCommand(this.projectPath, commands.lint)
        : notRun(),
      typecheck: commands.typecheck
        ? await tryCommand(this.projectPath, commands.typecheck)
        : notRun(),
    };
  }

  private async resolveCommands(): Promise<VerificationCommands> {
    if (this.options.verificationCommands) {
      return this.options.verificationCommands;
    }
    try {
      return await detectVerificationCommands(this.projectPath);
    } catch {
      return emptyVerificationCommands();
    }
  }
}

/** Keys of the executor "handoff" block (built-in builder prompts end with one). */
const HANDOFF_KEYS = [
  "whatChanged",
  "what_changed",
  "why",
  "assumptions",
  "unchanged",
  "risks",
  "limitations",
  "architectureSummary",
  "architecture_summary",
  "architecture",
] as const;

/**
 * The executor's structured handoff: the last fenced ```json block (or bare
 * ``` block) that parses to an object with at least one handoff key. Falls
 * back to the old rule — everything from the first `{` to the last `}` —
 * which breaks as soon as the reply contains any other braces.
 */
export function findExecutorHandoff(text: string): Record<string, unknown> | undefined {
  const blocks = fencedBlocks(text).filter(
    (b) => b.info === "" || b.info === "json" || b.info === "jsonc",
  );
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const parsed = parseJsonObject(blocks[i]!.body);
    if (parsed && HANDOFF_KEYS.some((key) => key in parsed)) {
      return parsed;
    }
  }
  const greedy = text.match(/\{[\s\S]*\}/);
  return greedy ? parseJsonObject(greedy[0]) : undefined;
}

/**
 * Fenced code blocks, line by line. A line of 3+ backticks opens a block (its
 * info string's first word is the language; an info string containing a
 * backtick is inline code, not a fence). A closing line is only backticks, at
 * least as many as the opener. An unclosed block is dropped.
 */
function fencedBlocks(text: string): Array<{ info: string; body: string }> {
  const blocks: Array<{ info: string; body: string }> = [];
  let open: { ticks: number; info: string; lines: string[] } | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!open) {
      const opener = /^\s*(`{3,})([^`]*)$/.exec(line);
      if (opener) {
        const info = (opener[2] ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        open = { ticks: opener[1]!.length, info, lines: [] };
      }
      continue;
    }
    const closer = /^\s*(`{3,})\s*$/.exec(line);
    if (closer && closer[1]!.length >= open.ticks) {
      blocks.push({ info: open.info, body: open.lines.join("\n") });
      open = undefined;
    } else {
      open.lines.push(line);
    }
  }
  return blocks;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseArchitectureSummary(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  // The executor's JSON handoff first (fenced block preferred, see findExecutorHandoff).
  const parsed = findExecutorHandoff(trimmed);
  const summary =
    parsed?.architectureSummary ?? parsed?.architecture_summary ?? parsed?.architecture;
  if (typeof summary === "string" && summary.trim()) {
    return summary.trim();
  }

  const sectionC = trimmed.match(
    /(?:^|\n)#+\s*Section C[^\n]*\n([\s\S]*?)(?=\n#+\s*Section [D-Z]|\n---\s*\n(?:####|###|##)|\n#### \d+\.|$)/i,
  );
  if (sectionC?.[1]?.trim()) {
    return sectionC[1].trim().slice(0, 12_000);
  }

  const archHeader = trimmed.match(
    /(?:^|\n)#+\s*Architecture[^\n]*\n([\s\S]*?)(?=\n#+\s+(?:Section [D-Z]|Inlined|Command Output)|\n---\s*\n(?:####|###)|$)/i,
  );
  const archBody = archHeader?.[1]?.trim();
  if (archBody && archBody.length > 80) {
    return archBody.slice(0, 12_000);
  }

  if (
    /clean architecture|presentation layer|domain layer|data layer|module layering|layer dependency/i.test(
      trimmed,
    )
  ) {
    const idx = trimmed.search(
      /clean architecture|presentation layer|module layering|layer dependency/i,
    );
    if (idx >= 0) {
      return trimmed.slice(idx, idx + 12_000).trim();
    }
  }

  return undefined;
}

const ARCHITECTURE_DOC_CANDIDATES = [
  "docs/architecture.md",
  "ARCHITECTURE.md",
  "architecture.md",
  "docs/ARCHITECTURE.md",
] as const;

/** Load committed architecture documentation when executor output lacks Section C. */
export async function loadProjectArchitectureDoc(
  projectPath: string,
): Promise<string | undefined> {
  for (const relative of ARCHITECTURE_DOC_CANDIDATES) {
    const trimmed = (await readGuardedProjectText(projectPath, relative))?.text.trim();
    if (trimmed && trimmed.length > 80) {
      return trimmed.slice(0, 12_000);
    }
  }
  return undefined;
}

export function isArchitectureHeavyTask(text: string): boolean {
  return /architecture|clean arch|layering|module bound|refactor|repository|providers?\.dart|hexagonal/i.test(
    text,
  );
}

/** Expand git-changed paths to related domain/data/presentation files in the same feature module. */
export function expandRelatedModuleFiles(changed: string[]): string[] {
  const expanded = new Set<string>();
  const moduleRe =
    /^(?:apps\/[^/]+\/)?(?:lib\/)?features\/([^/]+)\/(presentation|domain|data)\//;

  for (const file of changed) {
    const match = file.match(moduleRe);
    if (!match) {
      continue;
    }
    const [, module, layer] = match;
    const prefix = file.slice(0, file.indexOf(`/features/${module}/`) + `/features/${module}/`.length);

    if (layer === "presentation") {
      expanded.add(`${prefix}presentation/providers/${module}_providers.dart`);
      expanded.add(`${prefix}presentation/providers/${module}s_providers.dart`);
    }
    expanded.add(`${prefix}domain/repositories/${module}_repository.dart`);
    expanded.add(`${prefix}domain/repositories/${module}s_repository.dart`);
    expanded.add(`${prefix}data/repositories/${module}_repository_impl.dart`);
    expanded.add(`${prefix}data/repositories/${module}s_repository_impl.dart`);
  }

  for (const file of changed) {
    expanded.delete(file);
  }
  return [...expanded];
}

export function parseExecutorExplanation(
  text: string,
): ProjectReviewEvidencePack["executorExplanation"] {
  const trimmed = text.trim();
  const parsed = findExecutorHandoff(trimmed);
  if (parsed) {
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

function formatUnfulfilledEvidenceNote(request: EvidenceRequestItem): string {
  const target =
    "path" in request && request.path
      ? request.path
      : "command" in request && request.command
        ? request.command
        : "query" in request && request.query
          ? request.query
          : request.kind;
  return `Unfulfilled evidence (${request.kind}): ${target} — not available locally`;
}

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
    const child = spawn("git", args, { cwd, windowsHide: true });
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
