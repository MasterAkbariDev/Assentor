import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { EvidenceRequestItem } from "../protocol/messages.js";
import { EvidenceKind } from "../protocol/messages.js";
import {
  assertSafeProjectPath,
  readProjectFile,
  listProjectDirectory,
} from "../security/paths.js";
import { assertCommandAllowed } from "../security/commands.js";
import { redactSecrets } from "../security/redact.js";
import type { ArtifactCollector } from "./collector.js";
import { ArtifactType } from "./types.js";
import type { GitService } from "../git/types.js";

export interface EvidenceFulfillment {
  fulfilled: number;
  skipped: number;
  errors: string[];
}

export interface EvidenceCollectorDeps {
  projectPath: string;
  collector: ArtifactCollector;
  git?: GitService;
  runCommand?: (
    command: string,
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
}

/**
 * Validates and fulfills reviewer evidence requests into artifacts.
 * Prefer Assentor-local collection; skip kinds that need executor/runtime.
 */
export async function fulfillEvidenceRequests(
  requests: EvidenceRequestItem[],
  deps: EvidenceCollectorDeps,
): Promise<EvidenceFulfillment> {
  let fulfilled = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const request of requests) {
    try {
      const ok = await fulfillOne(request, deps);
      if (ok) {
        fulfilled += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      skipped += 1;
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { fulfilled, skipped, errors };
}

async function fulfillOne(
  request: EvidenceRequestItem,
  deps: EvidenceCollectorDeps,
): Promise<boolean> {
  switch (request.kind) {
    case EvidenceKind.File: {
      const absolute = assertSafeProjectPath(deps.projectPath, request.path);
      const raw = await readProjectFile(absolute);
      const redacted = redactSecrets(raw);
      deps.collector.addFile(
        request.path,
        redacted.text,
        request.description ?? request.path,
        { redacted: redacted.redacted },
      );
      return true;
    }
    case EvidenceKind.Files: {
      let any = false;
      for (const rel of request.paths) {
        try {
          const absolute = assertSafeProjectPath(deps.projectPath, rel);
          const raw = await readProjectFile(absolute);
          const redacted = redactSecrets(raw);
          deps.collector.addFile(
            rel,
            redacted.text,
            request.description ?? rel,
            { redacted: redacted.redacted },
          );
          any = true;
        } catch {
          // skip missing
        }
      }
      return any;
    }
    case EvidenceKind.Directory:
    case EvidenceKind.DirectoryTree:
    case EvidenceKind.ProjectStructure: {
      const relative =
        "path" in request && request.path ? request.path : ".";
      const absolute = assertSafeProjectPath(deps.projectPath, relative);
      const tree = await buildDirectoryTree(absolute, relative, 3);
      deps.collector.add({
        type: ArtifactType.ProjectStructure,
        path: relative,
        description: request.description ?? "directory tree",
        content: tree,
      });
      return true;
    }
    case EvidenceKind.GitDiff: {
      if (!deps.git) return false;
      const diff = await deps.git.diff();
      deps.collector.addGitDiff(diff);
      return true;
    }
    case EvidenceKind.GitLog: {
      if (!deps.git) return false;
      try {
        const log = await runGit(deps.projectPath, [
          "log",
          "-n",
          String(request.limit ?? 10),
          "--oneline",
        ]);
        deps.collector.add({
          type: ArtifactType.Other,
          description: request.description ?? "git log",
          content: log,
          source: "git",
        });
        return true;
      } catch {
        return false;
      }
    }
    case EvidenceKind.Command:
    case EvidenceKind.CommandOutput:
    case EvidenceKind.Test:
    case EvidenceKind.Build:
    case EvidenceKind.Lint:
    case EvidenceKind.Typecheck: {
      const command = resolveCommand(request);
      if (!command || !deps.runCommand) return false;
      assertCommandAllowed(command);
      const result = await deps.runCommand(command, deps.projectPath);
      const raw = [
        `$ ${command}`,
        result.stdout,
        result.stderr,
        `exit=${result.code}`,
      ]
        .filter(Boolean)
        .join("\n");
      const redacted = redactSecrets(raw);
      deps.collector.addCommandOutput(
        command,
        redacted.text,
        request.description,
        { redacted: redacted.redacted },
      );
      return true;
    }
    case EvidenceKind.Config:
    case EvidenceKind.Dependencies: {
      const rel =
        "path" in request && request.path ? request.path : "package.json";
      try {
        const absolute = assertSafeProjectPath(deps.projectPath, rel);
        const raw = await readProjectFile(absolute);
        const redacted = redactSecrets(raw);
        deps.collector.addFile(rel, redacted.text, request.description ?? rel, {
          redacted: redacted.redacted,
        });
        return true;
      } catch {
        return false;
      }
    }
    case EvidenceKind.Search:
    case EvidenceKind.Symbol:
    case EvidenceKind.Callers:
    case EvidenceKind.Implementations: {
      const query =
        "query" in request
          ? request.query
          : "symbol" in request
            ? request.symbol
            : "";
      if (!query) return false;
      const hits = await searchProject(deps.projectPath, query);
      deps.collector.add({
        type: ArtifactType.Other,
        description: request.description ?? `${request.kind}: ${query}`,
        content: hits || `(no matches for ${query})`,
        metadata: { kind: request.kind, query },
      });
      return true;
    }
    case EvidenceKind.Architecture:
    case EvidenceKind.RuntimeInformation:
    case EvidenceKind.Log:
    case EvidenceKind.Logs:
    case EvidenceKind.Screenshot:
    case EvidenceKind.Environment:
    case EvidenceKind.SceneHierarchy:
    case EvidenceKind.McpInspection:
      return false;
    default: {
      return false;
    }
  }
}

function resolveCommand(request: EvidenceRequestItem): string | undefined {
  if ("command" in request && request.command) return request.command;
  switch (request.kind) {
    case EvidenceKind.Test:
      return "npm test";
    case EvidenceKind.Build:
      return "npm run build";
    case EvidenceKind.Lint:
      return "npm run lint";
    case EvidenceKind.Typecheck:
      return "npx tsc --noEmit";
    default:
      return undefined;
  }
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
      else reject(new Error(err || `git ${args.join(" ")} failed`));
    });
  });
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  ".assentor",
  "vendor",
  "__pycache__",
]);

export async function buildDirectoryTree(
  absolute: string,
  displayRoot: string,
  maxDepth: number,
  depth = 0,
): Promise<string> {
  if (depth > maxDepth) return "";
  let entries: string[];
  try {
    entries = await listProjectDirectory(absolute);
  } catch {
    return `${displayRoot}/ (unreadable)`;
  }
  const lines: string[] = depth === 0 ? [`${displayRoot}/`] : [];
  const filtered = entries
    .filter((e) => !SKIP_DIRS.has(e) && !e.startsWith("."))
    .sort();
  for (const name of filtered.slice(0, 80)) {
    const childAbs = path.join(absolute, name);
    let isDir = false;
    try {
      isDir = (await fs.stat(childAbs)).isDirectory();
    } catch {
      continue;
    }
    const prefix = "  ".repeat(depth + 1);
    if (isDir) {
      lines.push(`${prefix}${name}/`);
      const nested = await buildDirectoryTree(
        childAbs,
        name,
        maxDepth,
        depth + 1,
      );
      if (nested) {
        lines.push(
          ...nested
            .split("\n")
            .slice(1)
            .filter(Boolean),
        );
      }
    } else {
      lines.push(`${prefix}${name}`);
    }
  }
  return lines.join("\n");
}

export async function searchProject(
  projectPath: string,
  query: string,
  maxHits = 40,
): Promise<string> {
  const root = path.resolve(projectPath);
  const hits: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (hits.length >= maxHits) return;
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      const raw = await fs.readdir(dir, { withFileTypes: true });
      entries = raw;
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hits.length >= maxHits) return;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|json|md)$/i.test(entry.name)) {
        continue;
      }
      try {
        const content = await fs.readFile(full, "utf8");
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          if (hits.length >= maxHits) return;
          if (line.includes(query)) {
            const rel = path.relative(root, full);
            hits.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      } catch {
        // skip
      }
    }
  }

  await walk(root);
  return hits.join("\n");
}

export { SKIP_DIRS };
