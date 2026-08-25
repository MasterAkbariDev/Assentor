import { createId } from "../core/ids.js";
import type { Artifact } from "./types.js";
import { ArtifactType } from "./types.js";

export interface ArtifactCollectorOptions {
  source?: Artifact["source"];
}

/**
 * In-memory artifact registry for a task run.
 * Persistence to `.assentor/artifacts/` arrives in Phase 7.
 */
export class ArtifactCollector {
  private readonly artifacts: Artifact[] = [];
  private readonly defaultSource: Artifact["source"];

  constructor(options: ArtifactCollectorOptions = {}) {
    this.defaultSource = options.source ?? "supervisor";
  }

  add(
    input: Omit<Artifact, "id" | "createdAt" | "source"> & {
      id?: string;
      createdAt?: string;
      source?: Artifact["source"];
    },
  ): Artifact {
    const artifact: Artifact = {
      id: input.id ?? createId(),
      type: input.type,
      path: input.path,
      description: input.description,
      content: input.content,
      createdAt: input.createdAt ?? new Date().toISOString(),
      source: input.source ?? this.defaultSource,
      redacted: input.redacted,
      metadata: input.metadata,
    };
    this.artifacts.push(artifact);
    return artifact;
  }

  addGitStatus(content: string, description = "git status"): Artifact {
    return this.add({
      type: ArtifactType.GitStatus,
      description,
      content,
      source: "git",
    });
  }

  addGitDiff(content: string, description = "git diff"): Artifact {
    return this.add({
      type: ArtifactType.GitDiff,
      description,
      content,
      source: "git",
    });
  }

  addChangedFiles(files: string[], description = "changed files"): Artifact {
    return this.add({
      type: ArtifactType.ChangedFiles,
      description,
      content: files.join("\n"),
      source: "git",
      metadata: { files },
    });
  }

  addFile(
    path: string,
    content: string,
    description?: string,
    options?: { redacted?: boolean },
  ): Artifact {
    return this.add({
      type: ArtifactType.File,
      path,
      content,
      description: description ?? path,
      source: "supervisor",
      redacted: options?.redacted,
    });
  }

  addCommandOutput(
    command: string,
    output: string,
    description?: string,
    options?: { redacted?: boolean },
  ): Artifact {
    return this.add({
      type: ArtifactType.CommandOutput,
      description: description ?? command,
      content: output,
      metadata: { command },
      redacted: options?.redacted,
    });
  }

  list(filter?: { type?: string; source?: Artifact["source"] }): Artifact[] {
    return this.artifacts.filter((artifact) => {
      if (filter?.type !== undefined && artifact.type !== filter.type) {
        return false;
      }
      if (filter?.source !== undefined && artifact.source !== filter.source) {
        return false;
      }
      return true;
    });
  }

  get(id: string): Artifact | undefined {
    return this.artifacts.find((artifact) => artifact.id === id);
  }

  clear(): void {
    this.artifacts.length = 0;
  }

  toReviewRefs(): Array<{
    id: string;
    type: string;
    path?: string;
    description?: string;
    content?: string;
  }> {
    return this.artifacts.map((artifact) => ({
      id: artifact.id,
      type: artifact.type,
      path: artifact.path,
      description: artifact.description,
      content: artifact.content,
    }));
  }
}
