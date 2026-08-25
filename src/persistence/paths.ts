import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ASSENTOR_DIR = ".assentor";

export interface TaskPaths {
  root: string;
  taskDir: string;
  stateFile: string;
  eventsFile: string;
  historyFile: string;
  contractFile: string;
  taskMdFile: string;
  artifactsDir: string;
  historyDir: string;
  reportsDir: string;
  checkpointsDir: string;
}

export function assentorRoot(projectPath: string): string {
  return path.join(path.resolve(projectPath), ASSENTOR_DIR);
}

export function taskPaths(projectPath: string, taskId: string): TaskPaths {
  const root = assentorRoot(projectPath);
  const taskDir = path.join(root, "tasks", taskId);
  return {
    root,
    taskDir,
    stateFile: path.join(taskDir, "state.json"),
    eventsFile: path.join(taskDir, "events.jsonl"),
    historyFile: path.join(taskDir, "history.jsonl"),
    contractFile: path.join(taskDir, "contract.json"),
    taskMdFile: path.join(taskDir, "task.md"),
    artifactsDir: path.join(taskDir, "artifacts"),
    historyDir: path.join(taskDir, "history"),
    reportsDir: path.join(taskDir, "reports"),
    checkpointsDir: path.join(taskDir, "checkpoints"),
  };
}

export async function ensureTaskLayout(
  projectPath: string,
  taskId: string,
): Promise<TaskPaths> {
  const paths = taskPaths(projectPath, taskId);
  await fs.mkdir(paths.taskDir, { recursive: true });
  await fs.mkdir(paths.artifactsDir, { recursive: true });
  await fs.mkdir(path.join(paths.artifactsDir, "diffs"), { recursive: true });
  await fs.mkdir(path.join(paths.artifactsDir, "logs"), { recursive: true });
  await fs.mkdir(path.join(paths.artifactsDir, "screenshots"), {
    recursive: true,
  });
  await fs.mkdir(path.join(paths.artifactsDir, "test-results"), {
    recursive: true,
  });
  await fs.mkdir(paths.historyDir, { recursive: true });
  await fs.mkdir(paths.reportsDir, { recursive: true });
  await fs.mkdir(paths.checkpointsDir, { recursive: true });
  return paths;
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(tmp, payload, "utf8");
  await fs.rename(tmp, filePath);
}

export async function readJsonFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return schema.parse(parsed);
}

export async function appendJsonl(
  filePath: string,
  value: unknown,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export async function readJsonl<T = unknown>(filePath: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function listTaskIds(projectPath: string): Promise<string[]> {
  const root = path.join(assentorRoot(projectPath), "tasks");
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
