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
  /**
   * Optional command runner. When omitted, command/test/build requests are skipped.
   */
  runCommand?: (
    command: string,
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
}

/**
 * Validates and fulfills reviewer evidence requests into artifacts.
 * Does not invent project state — only collects what is available safely.
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
    case EvidenceKind.Directory: {
      const absolute = assertSafeProjectPath(deps.projectPath, request.path);
      const entries = await listProjectDirectory(absolute);
      deps.collector.add({
        type: ArtifactType.DirectoryListing,
        path: request.path,
        description: request.description ?? request.path,
        content: entries.join("\n"),
      });
      return true;
    }
    case EvidenceKind.GitDiff: {
      if (!deps.git) {
        return false;
      }
      const diff = await deps.git.diff();
      deps.collector.addGitDiff(diff);
      return true;
    }
    case EvidenceKind.ProjectStructure: {
      const relative = request.path ?? ".";
      const absolute = assertSafeProjectPath(deps.projectPath, relative);
      const entries = await listProjectDirectory(absolute);
      deps.collector.add({
        type: ArtifactType.ProjectStructure,
        path: relative,
        description: request.description ?? "project structure",
        content: entries.join("\n"),
      });
      return true;
    }
    case EvidenceKind.Command:
    case EvidenceKind.Test:
    case EvidenceKind.Build: {
      const command =
        "command" in request && request.command
          ? request.command
          : request.kind === EvidenceKind.Test
            ? "npm test"
            : request.kind === EvidenceKind.Build
              ? "npm run build"
              : undefined;

      if (!command || !deps.runCommand) {
        return false;
      }

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
    case EvidenceKind.Log:
    case EvidenceKind.Screenshot:
    case EvidenceKind.Environment:
    case EvidenceKind.SceneHierarchy:
    case EvidenceKind.McpInspection:
      // These require executor/runtime integrations (later phases).
      return false;
    default: {
      const _exhaustive: never = request;
      return _exhaustive;
    }
  }
}
