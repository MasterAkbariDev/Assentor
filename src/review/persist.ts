import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ProjectReviewEvidencePackSchema,
  type ProjectReviewEvidencePack,
} from "./evidence-pack.js";

export function evidencePackDir(
  projectPath: string,
  taskId: string,
): string {
  return path.join(
    path.resolve(projectPath),
    ".assentor",
    "tasks",
    taskId,
    "evidence",
  );
}

export function evidencePackJsonPath(
  projectPath: string,
  taskId: string,
): string {
  return path.join(evidencePackDir(projectPath, taskId), "pack.json");
}

export async function saveEvidencePack(
  pack: ProjectReviewEvidencePack,
  taskId: string,
): Promise<{ jsonPath: string; mdPath: string }> {
  const dir = evidencePackDir(pack.projectPath, taskId);
  await fs.mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, "pack.json");
  const mdPath = path.join(dir, "pack.md");
  const updated = {
    ...pack,
    updatedAt: new Date().toISOString(),
    taskId,
  };
  await fs.writeFile(
    jsonPath,
    `${JSON.stringify(updated, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(mdPath, evidencePackToMarkdown(updated), "utf8");
  return { jsonPath, mdPath };
}

export async function loadEvidencePack(
  projectPath: string,
  taskId: string,
): Promise<ProjectReviewEvidencePack | null> {
  try {
    const raw = await fs.readFile(
      evidencePackJsonPath(projectPath, taskId),
      "utf8",
    );
    return ProjectReviewEvidencePackSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function evidencePackToMarkdown(pack: ProjectReviewEvidencePack): string {
  const lines: string[] = [
    `# Project Review Evidence Pack`,
    ``,
    `- Project: \`${pack.projectPath}\``,
    `- Task: ${pack.taskId ?? "(none)"}`,
    `- Round: ${pack.round}`,
    `- Depth: ${pack.depth}`,
    `- Updated: ${pack.updatedAt}`,
    ``,
    `## A. Project Overview`,
    ``,
    `- Type: ${pack.overview.projectType ?? "unknown"}`,
    `- Language: ${pack.overview.language ?? "unknown"}`,
    `- Framework: ${pack.overview.framework ?? "unknown"}`,
    `- Package manager: ${pack.overview.packageManager ?? "unknown"}`,
    `- Test: ${pack.overview.testFramework ?? "unknown"}`,
    `- Major deps: ${pack.overview.majorDependencies.join(", ") || "(none)"}`,
    ``,
    `## B. Project Structure`,
    ``,
    "```",
    pack.structure.tree || "(empty)",
    "```",
    ``,
    `## C. Architecture`,
    ``,
    pack.architecture.summary || "(missing)",
    ``,
    `## D. Relevant Files`,
    ``,
    ...pack.relevantFiles.map(
      (f) => `- [${f.role}] \`${f.path}\`${f.truncated ? " (truncated)" : ""}`,
    ),
    ``,
    `## E. Important Unchanged Code`,
    ``,
    ...pack.unchangedImportant.map(
      (f) => `- [${f.role}] \`${f.path}\`${f.truncated ? " (truncated)" : ""}`,
    ),
    ``,
    `## G. Git`,
    ``,
    `- Branch: ${pack.git.branch ?? "n/a"}`,
    `- Commit: ${pack.git.commit ?? "n/a"}`,
    `- Baseline (task start): ${pack.git.baselineCommit ?? "n/a"}`,
    `- Working tree: ${pack.git.workingTreeClean ? "clean" : "dirty"}`,
    `- Changed since task start: ${pack.git.changedFiles.join(", ") || "(none)"}`,
    pack.git.note ? `- Note: ${pack.git.note}` : "",
    ``,
    `## H. Tests / Build`,
    ``,
    `- test: ${pack.tests.test.status}`,
    `- build: ${pack.tests.build.status}`,
    `- lint: ${pack.tests.lint.status}`,
    `- typecheck: ${pack.tests.typecheck.status}`,
    ``,
    `## K. Executor Explanation`,
    ``,
    pack.executorExplanation.whatChanged ||
      pack.executorExplanation.raw ||
      "(missing)",
    ``,
  ];
  return lines.join("\n");
}
