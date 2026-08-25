/**
 * Parse Cursor CLI `--output-format stream-json` NDJSON into human status updates.
 */

export type AgentActivity =
  | "starting"
  | "thinking"
  | "reading"
  | "editing"
  | "writing"
  | "searching"
  | "running"
  | "exploring"
  | "planning"
  | "waiting";

export interface AgentStatusUpdate {
  activity: AgentActivity;
  detail: string;
  sessionId?: string;
  /** Final assistant result text when type=result */
  resultText?: string;
}

type JsonObject = Record<string, unknown>;

/**
 * Incremental NDJSON line buffer for Cursor stream-json stdout.
 */
export class CursorStreamStatusParser {
  private buffer = "";
  private lastResultText = "";
  private sessionId?: string;

  push(chunk: string): AgentStatusUpdate[] {
    this.buffer += chunk;
    const updates: AgentStatusUpdate[] = [];

    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");

      if (!line) {
        continue;
      }
      const update = parseStreamLine(line);
      if (!update) {
        continue;
      }
      if (update.sessionId) {
        this.sessionId = update.sessionId;
      }
      if (update.resultText) {
        this.lastResultText = update.resultText;
      }
      updates.push(update);
    }

    return updates;
  }

  /** Flush any trailing incomplete line (usually nothing useful). */
  flush(): AgentStatusUpdate[] {
    const line = this.buffer.trim();
    this.buffer = "";
    if (!line) {
      return [];
    }
    const update = parseStreamLine(line);
    return update ? [update] : [];
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getResultText(): string {
    return this.lastResultText;
  }
}

export function parseStreamLine(line: string): AgentStatusUpdate | undefined {
  let event: JsonObject;
  try {
    event = JSON.parse(line) as JsonObject;
  } catch {
    // Plain text fallback (older text mode chunks)
    const text = line.replace(/\s+/g, " ").trim();
    if (!text || text.length < 3) {
      return undefined;
    }
    return { activity: "running", detail: truncate(text, 56) };
  }

  const type = String(event.type ?? "");
  const sessionId =
    typeof event.session_id === "string"
      ? event.session_id
      : typeof event.sessionId === "string"
        ? event.sessionId
        : undefined;

  if (type === "system") {
    const model =
      typeof event.model === "string" ? event.model : undefined;
    return {
      activity: "starting",
      detail: model ? `model ${model}` : "session started",
      sessionId,
    };
  }

  if (type === "assistant") {
    // Skip duplicate flushes when stream-partial-output is on.
    if (event.model_call_id != null) {
      return undefined;
    }
    const text = extractAssistantText(event);
    if (!text) {
      return { activity: "thinking", detail: "planning next step", sessionId };
    }
    return {
      activity: "thinking",
      detail: truncate(text.replace(/\s+/g, " "), 56),
      sessionId,
    };
  }

  if (type === "tool_call") {
    const subtype = String(event.subtype ?? "");
    const toolCall =
      event.tool_call && typeof event.tool_call === "object"
        ? (event.tool_call as JsonObject)
        : {};
    const mapped = describeToolCall(toolCall, subtype === "completed");
    return {
      activity: mapped.activity,
      detail: mapped.detail,
      sessionId,
    };
  }

  if (type === "result") {
    const result =
      typeof event.result === "string"
        ? event.result
        : typeof event.message === "string"
          ? event.message
          : "";
    return {
      activity: "waiting",
      detail: "finishing up",
      sessionId,
      resultText: result,
    };
  }

  if (type === "thinking") {
    return {
      activity: "thinking",
      detail: "reasoning",
      sessionId,
    };
  }

  return undefined;
}

function describeToolCall(
  toolCall: JsonObject,
  completed: boolean,
): { activity: AgentActivity; detail: string } {
  const verb = completed ? "did" : "doing";
  void verb;

  for (const [key, value] of Object.entries(toolCall)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const payload = value as JsonObject;
    const args =
      payload.args && typeof payload.args === "object"
        ? (payload.args as JsonObject)
        : payload;

    switch (key) {
      case "readToolCall":
        return {
          activity: "reading",
          detail: shortPath(stringArg(args, "path") ?? "file"),
        };
      case "writeToolCall":
        return {
          activity: "writing",
          detail: shortPath(stringArg(args, "path") ?? "file"),
        };
      case "editToolCall":
      case "searchReplaceToolCall":
      case "strReplaceToolCall":
      case "applyPatchToolCall":
        return {
          activity: "editing",
          detail: shortPath(
            stringArg(args, "path") ??
              stringArg(args, "filePath") ??
              stringArg(args, "file_path") ??
              "file",
          ),
        };
      case "deleteToolCall":
        return {
          activity: "editing",
          detail: `delete ${shortPath(stringArg(args, "path") ?? "file")}`,
        };
      case "shellToolCall":
      case "bashToolCall":
      case "runTerminalCommandToolCall":
        return {
          activity: "running",
          detail: truncate(
            stringArg(args, "command") ??
              stringArg(args, "cmd") ??
              "shell command",
            56,
          ),
        };
      case "grepToolCall":
      case "rgToolCall":
        return {
          activity: "searching",
          detail: truncate(
            stringArg(args, "pattern") ??
              stringArg(args, "query") ??
              "search",
            56,
          ),
        };
      case "globToolCall":
      case "lsToolCall":
      case "listDirToolCall":
        return {
          activity: "exploring",
          detail: truncate(
            stringArg(args, "glob") ??
              stringArg(args, "globPattern") ??
              stringArg(args, "path") ??
              "files",
            56,
          ),
        };
      case "todoToolCall":
      case "updateTodosToolCall":
        return {
          activity: "planning",
          detail: "updating todos",
        };
      case "function": {
        const name = stringArg(args, "name") ?? "tool";
        const rawArgs = stringArg(args, "arguments") ?? "";
        return describeFunctionTool(name, rawArgs);
      }
      default: {
        // CamelCase *ToolCall → human label
        const label = key.replace(/ToolCall$/, "").replace(/([A-Z])/g, " $1").trim();
        const pathish =
          stringArg(args, "path") ??
          stringArg(args, "filePath") ??
          stringArg(args, "command");
        return {
          activity: guessActivityFromName(key),
          detail: pathish ? shortPath(pathish) : truncate(label || key, 56),
        };
      }
    }
  }

  return { activity: "running", detail: "using a tool" };
}

function describeFunctionTool(
  name: string,
  rawArgs: string,
): { activity: AgentActivity; detail: string } {
  let args: JsonObject = {};
  try {
    args = JSON.parse(rawArgs) as JsonObject;
  } catch {
    // ignore
  }
  const lower = name.toLowerCase();
  if (lower.includes("read")) {
    return {
      activity: "reading",
      detail: shortPath(stringArg(args, "path") ?? name),
    };
  }
  if (lower.includes("write") || lower.includes("create")) {
    return {
      activity: "writing",
      detail: shortPath(stringArg(args, "path") ?? name),
    };
  }
  if (lower.includes("edit") || lower.includes("replace") || lower.includes("patch")) {
    return {
      activity: "editing",
      detail: shortPath(
        stringArg(args, "path") ?? stringArg(args, "file_path") ?? name,
      ),
    };
  }
  if (lower.includes("shell") || lower.includes("bash") || lower.includes("terminal")) {
    return {
      activity: "running",
      detail: truncate(stringArg(args, "command") ?? name, 56),
    };
  }
  if (lower.includes("grep") || lower.includes("search")) {
    return {
      activity: "searching",
      detail: truncate(stringArg(args, "pattern") ?? name, 56),
    };
  }
  return {
    activity: guessActivityFromName(name),
    detail: truncate(name, 56),
  };
}

function guessActivityFromName(name: string): AgentActivity {
  const lower = name.toLowerCase();
  if (lower.includes("read")) return "reading";
  if (lower.includes("write")) return "writing";
  if (lower.includes("edit") || lower.includes("replace")) return "editing";
  if (lower.includes("shell") || lower.includes("bash") || lower.includes("run")) {
    return "running";
  }
  if (lower.includes("grep") || lower.includes("search")) return "searching";
  if (lower.includes("glob") || lower.includes("list") || lower.includes("ls")) {
    return "exploring";
  }
  if (lower.includes("todo")) return "planning";
  return "running";
}

function extractAssistantText(event: JsonObject): string {
  const message = event.message;
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as JsonObject).content;
  if (!Array.isArray(content)) {
    return typeof (message as JsonObject).content === "string"
      ? String((message as JsonObject).content)
      : "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const text = (part as JsonObject).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function stringArg(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shortPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return truncate(normalized, 56);
  }
  return truncate(parts.slice(-2).join("/"), 56);
}

function truncate(value: string, max: number): string {
  const one = value.replace(/\s+/g, " ").trim();
  if (one.length <= max) {
    return one;
  }
  return `${one.slice(0, max - 1)}…`;
}

/** Extract final result + session id from a full stream-json stdout blob. */
export function summarizeStreamJson(stdout: string): {
  summary: string;
  sessionId?: string;
} {
  let summary = "";
  let sessionId: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as JsonObject;
      if (typeof event.session_id === "string") {
        sessionId = event.session_id;
      }
      if (event.type === "result" && typeof event.result === "string") {
        summary = event.result;
      }
    } catch {
      // skip
    }
  }
  if (!summary) {
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    summary = lines.at(-1) ?? "";
  }
  return { summary: summary.slice(0, 500), sessionId };
}
