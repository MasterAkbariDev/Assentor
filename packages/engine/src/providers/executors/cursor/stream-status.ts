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
  /** Provider error string on a terminal result event (e.g. Antigravity `error`). */
  resultError?: string;
  /** True when Cursor emitted the terminal stream-json `result` event. */
  isFinal?: boolean;
  /** True when that result event reports failure. */
  resultFailed?: boolean;
}

type JsonObject = Record<string, unknown>;

/**
 * Incremental NDJSON line buffer for Cursor stream-json stdout.
 */
export class CursorStreamStatusParser {
  private buffer = "";
  private lastResultText = "";
  private lastResultError = "";
  private sessionId?: string;
  private sawFinal = false;
  private resultFailed = false;

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
      const update = this.record(parseStreamLine(line));
      if (update) {
        updates.push(update);
      }
    }

    // Cursor sometimes emits the final result object without a trailing newline.
    const trailing = this.buffer.trim();
    if (trailing.startsWith("{") && trailing.endsWith("}")) {
      const update = this.record(parseStreamLine(trailing));
      if (update) {
        this.buffer = "";
        updates.push(update);
      }
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
    const update = this.record(parseStreamLine(line));
    return update ? [update] : [];
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getResultText(): string {
    return this.lastResultText;
  }

  getResultError(): string {
    return this.lastResultError;
  }

  hasFinalResult(): boolean {
    return this.sawFinal;
  }

  isResultError(): boolean {
    return this.resultFailed;
  }

  private record(update: AgentStatusUpdate | undefined): AgentStatusUpdate | undefined {
    if (!update) {
      return undefined;
    }
    if (update.sessionId) {
      this.sessionId = update.sessionId;
    }
    if (update.resultText) {
      this.lastResultText = update.resultText;
    }
    if (update.resultError) {
      this.lastResultError = update.resultError;
    }
    if (update.isFinal) {
      this.sawFinal = true;
      this.resultFailed = Boolean(update.resultFailed);
    }
    return update;
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

  if (typeof event.event === "string") {
    return parseAntigravityStreamEvent(event);
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
    const subtype = String(event.subtype ?? "").toLowerCase();
    const resultFailed =
      subtype === "error" ||
      event.is_error === true ||
      event.isError === true;
    return {
      activity: "waiting",
      detail: resultFailed
        ? "result received with errors"
        : "result received — waiting for process to exit",
      sessionId,
      resultText: result,
      isFinal: true,
      resultFailed,
    };
  }

  if (type === "thinking") {
    const text =
      extractAssistantText(event) ||
      (typeof event.text === "string" ? event.text : "") ||
      (typeof event.delta === "string" ? event.delta : "");
    return {
      activity: "thinking",
      detail: text
        ? truncate(text.replace(/\s+/g, " "), 56)
        : "model thinking — this can take a few minutes",
      sessionId,
    };
  }

  return undefined;
}

function parseAntigravityStreamEvent(
  event: JsonObject,
): AgentStatusUpdate | undefined {
  const eventName = String(event.event);
  const sessionId =
    typeof event.conversation_id === "string"
      ? event.conversation_id
      : undefined;

  if (eventName === "init") {
    const init =
      event.init && typeof event.init === "object"
        ? (event.init as JsonObject)
        : {};
    const cwd =
      stringArg(init, "cwd") ??
      stringArg(init, "workspace") ??
      stringArg(init, "projectPath");
    const tools = Array.isArray(init.tools) ? init.tools.length : undefined;
    const parts: string[] = [];
    if (cwd) {
      parts.push(`workspace ${shortPath(cwd)}`);
    }
    if (tools !== undefined) {
      parts.push(`${tools} tools`);
    }
    return {
      activity: "starting",
      detail: parts.length ? parts.join(" · ") : "session started",
      sessionId,
    };
  }

  if (eventName === "result") {
    const result =
      event.result && typeof event.result === "object"
        ? (event.result as JsonObject)
        : {};
    const response =
      typeof result.response === "string" ? result.response : "";
    const errorText =
      typeof result.error === "string" ? result.error.trim() : "";
    const status = String(result.status ?? "").toUpperCase();
    return {
      activity: "waiting",
      detail:
        status && status !== "SUCCESS"
          ? errorText
            ? truncate(errorText, 56)
            : "result received with errors"
          : "result received — waiting for process to exit",
      sessionId:
        typeof result.conversation_id === "string"
          ? result.conversation_id
          : sessionId,
      resultText: response,
      resultError: errorText || undefined,
      isFinal: true,
      resultFailed: status !== "" && status !== "SUCCESS",
    };
  }

  if (eventName !== "step_update") {
    return undefined;
  }

  const step =
    event.step_update && typeof event.step_update === "object"
      ? (event.step_update as JsonObject)
      : {};
  const stepType = String(step.step_type ?? "");
  const state = String(step.state ?? "").toUpperCase();
  const stepSessionId =
    typeof step.conversation_id === "string" ? step.conversation_id : sessionId;

  if (stepType === "tool") {
    const stepIndex =
      typeof step.step_index === "number" ? step.step_index : undefined;
    const toolName = String(step.tool_name ?? "tool");
    const toolInfo =
      step.tool_info && typeof step.tool_info === "object"
        ? (step.tool_info as JsonObject)
        : {};
    const params =
      toolInfo.parameters && typeof toolInfo.parameters === "object"
        ? (toolInfo.parameters as JsonObject)
        : {};
    const mapped = describeAntigravityTool(toolName, params, stepIndex);
    if (state === "ACTIVE") {
      return { ...mapped, sessionId: stepSessionId };
    }
    if (state === "DONE" || state === "ERROR") {
      return {
        activity: mapped.activity,
        detail: formatAntigravityToolCompletion(
          mapped.detail,
          toolInfo,
          state === "ERROR",
        ),
        sessionId: stepSessionId,
      };
    }
    return undefined;
  }

  if (stepType === "agent_response") {
    // Skip prose/code deltas in the live spinner — tool events are the signal.
    return undefined;
  }

  return undefined;
}

function describeAntigravityTool(
  toolName: string,
  params: JsonObject,
  stepIndex?: number,
): { activity: AgentActivity; detail: string } {
  const prefix = stepIndex != null ? `#${stepIndex} · ` : "";
  const path =
    stringArg(params, "DirectoryPath") ??
    stringArg(params, "Path") ??
    stringArg(params, "path") ??
    stringArg(params, "FilePath") ??
    stringArg(params, "file_path");
  const command = stringArg(params, "Command") ?? stringArg(params, "command");
  const commandLine =
    stringArg(params, "CommandLine") ?? stringArg(params, "commandLine");
  const pattern =
    stringArg(params, "Pattern") ??
    stringArg(params, "pattern") ??
    stringArg(params, "Query") ??
    stringArg(params, "query");
  const searchPath =
    stringArg(params, "SearchPath") ?? stringArg(params, "searchPath");

  switch (toolName) {
    case "view_file":
    case "read_resource":
    case "read_url_content":
    case "read_browser_page":
      return {
        activity: "reading",
        detail: `${prefix}read ${shortPath(path ?? "file")}`,
      };
    case "write_to_file":
      return {
        activity: "writing",
        detail: `${prefix}write ${shortPath(path ?? "file")}`,
      };
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
      return {
        activity: "editing",
        detail: `${prefix}edit ${shortPath(path ?? "file")}`,
      };
    case "run_command":
    case "send_command_input":
      return {
        activity: "running",
        detail: `${prefix}${truncate(commandLine ?? command ?? "shell command", 72)}`,
      };
    case "grep_search":
    case "find_by_name":
    case "search_web": {
      const query = pattern ?? toolName.replace(/_/g, " ");
      const scoped = searchPath
        ? `${query} in ${shortPath(searchPath)}`
        : query;
      return {
        activity: "searching",
        detail: `${prefix}${truncate(scoped, 72)}`,
      };
    }
    case "list_dir":
      return {
        activity: "exploring",
        detail: `${prefix}list ${shortPath(path ?? "directory")}`,
      };
    default:
      return {
        activity: "running",
        detail: `${prefix}${truncate(toolName.replace(/_/g, " "), 72)}`,
      };
  }
}

function formatAntigravityToolCompletion(
  activeDetail: string,
  toolInfo: JsonObject,
  failed: boolean,
): string {
  const parts = [activeDetail];
  const durationMs =
    typeof toolInfo.duration_ms === "number"
      ? toolInfo.duration_ms
      : typeof toolInfo.durationMs === "number"
        ? toolInfo.durationMs
        : undefined;
  if (durationMs != null && durationMs > 0) {
    parts.push(formatDuration(durationMs));
  }
  const error =
    stringArg(toolInfo, "error") ??
    stringArg(toolInfo, "Error") ??
    stringArg(toolInfo, "message");
  if (failed && error) {
    parts.push(truncate(error, 48));
  } else {
    const preview = extractToolOutputPreview(toolInfo);
    if (preview) {
      parts.push(truncate(preview, 48));
    }
  }
  parts.push(failed ? "failed" : "done");
  return parts.join(" · ");
}

function extractToolOutputPreview(toolInfo: JsonObject): string {
  for (const key of [
    "output",
    "stdout",
    "result",
    "response",
    "summary",
    "content",
  ]) {
    const value = toolInfo[key];
    if (typeof value === "string" && value.trim()) {
      return firstMeaningfulLine(value);
    }
  }
  return "";
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const one = line.replace(/\s+/g, " ").trim();
    if (one.length >= 3) {
      return one;
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const sec = ms / 1000;
  if (sec < 60) {
    return `${sec.toFixed(sec >= 10 ? 0 : 1)}s`;
  }
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return rem > 0 ? `${min}m ${rem}s` : `${min}m`;
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
      if (typeof event.conversation_id === "string") {
        sessionId = event.conversation_id;
      }
      if (event.type === "result" && typeof event.result === "string") {
        summary = event.result;
      }
      if (event.event === "result" && event.result && typeof event.result === "object") {
        const result = event.result as JsonObject;
        if (typeof result.response === "string") {
          summary = result.response;
        }
        if (typeof result.conversation_id === "string") {
          sessionId = result.conversation_id;
        }
      }
    } catch {
      // skip
    }
  }
  if (!summary) {
    summary = summarizePartialStreamOutput(stdout);
  }
  return { summary: summary.slice(0, 500), sessionId };
}

/** Best-effort human summary when no terminal `result` event was captured. */
export function summarizePartialStreamOutput(stdout: string): string {
  let toolSteps = 0;
  let lastTool = "";
  let prose = "";

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let event: JsonObject;
    try {
      event = JSON.parse(trimmed) as JsonObject;
    } catch {
      continue;
    }

    if (event.event === "step_update") {
      const step =
        event.step_update && typeof event.step_update === "object"
          ? (event.step_update as JsonObject)
          : {};
      if (step.step_type === "tool") {
        const state = String(step.state ?? "").toUpperCase();
        if (state === "ACTIVE") {
          toolSteps += 1;
          const toolName = String(step.tool_name ?? "tool");
          const toolInfo =
            step.tool_info && typeof step.tool_info === "object"
              ? (step.tool_info as JsonObject)
              : {};
          const params =
            toolInfo.parameters && typeof toolInfo.parameters === "object"
              ? (toolInfo.parameters as JsonObject)
              : {};
          lastTool = describeAntigravityTool(
            toolName,
            params,
            typeof step.step_index === "number" ? step.step_index : undefined,
          ).detail;
        } else if (state === "DONE") {
          toolSteps += 1;
        }
      }
      if (
        typeof step.text_delta === "string" &&
        step.text_delta.trim() &&
        !looksLikeCodeFragment(step.text_delta)
      ) {
        prose += step.text_delta;
      }
    }

    if (event.type === "assistant") {
      const text = extractAssistantText(event);
      if (text && !looksLikeCodeFragment(text)) {
        prose = text;
      }
    }
  }

  const trimmedProse = prose.replace(/\s+/g, " ").trim();
  if (trimmedProse.length >= 12) {
    return truncate(trimmedProse, 500);
  }
  if (lastTool) {
    return `Ran ${toolSteps} tool step(s); last: ${lastTool}`;
  }
  if (toolSteps > 0) {
    return `Ran ${toolSteps} tool step(s); no final response captured`;
  }
  return "";
}

export function isExecutorStreamBlob(text: string): boolean {
  const sample = text.trim().slice(0, 4000);
  if (!sample.startsWith("{")) {
    return false;
  }
  return (
    sample.includes('"type":"tool_call"') ||
    sample.includes('"event":"init"') ||
    sample.includes('"event":"step_update"') ||
    sample.includes('"event":"result"')
  );
}

function looksLikeCodeFragment(text: string): boolean {
  const one = text.replace(/\s+/g, " ").trim();
  if (!one) {
    return true;
  }
  if (/^(import |export |const |let |function |class |\/\/|\/\*)/.test(one)) {
    return true;
  }
  if (/SELECTABLE_|EXECUTOR_|REVIEWER_|\.tsx?|\.js["']/.test(one)) {
    return true;
  }
  return one.length > 120 && /[{}();]/.test(one);
}

/** Prefer parsed stream summary over raw NDJSON stdout. */
export function summarizeExecutorStreamOutput(stdout: string): string {
  const parsed = summarizeStreamJson(stdout);
  if (parsed.summary && !isExecutorStreamBlob(parsed.summary)) {
    return parsed.summary;
  }
  const partial = summarizePartialStreamOutput(stdout);
  if (partial) {
    return partial;
  }
  return "";
}

/** Human failure message — never return raw stream-json blobs. */
export function resolveExecutorFailureMessage(input: {
  executorName: string;
  parser?: Pick<
    CursorStreamStatusParser,
    "getResultText" | "getResultError" | "hasFinalResult" | "isResultError"
  >;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
}): { summary: string; error: string; kind: "failed" | "timeout" } {
  const resultError = input.parser?.getResultError()?.trim() ?? "";
  const resultText = input.parser?.getResultText()?.trim() ?? "";
  const stderr = input.stderr.trim();

  let detail = resultError || resultText || stderr;
  if (!detail || isExecutorStreamBlob(detail)) {
    const partial = summarizeExecutorStreamOutput(input.stdout);
    if (partial) {
      detail = partial;
    }
  }
  if (!detail || isExecutorStreamBlob(detail)) {
    detail =
      input.exitCode != null && input.exitCode !== 0
        ? `${input.executorName} exited ${input.exitCode}`
        : `${input.executorName} reported an error`;
  }

  const timeoutHint = /timeout/i.test(resultError) || /timeout/i.test(detail);
  const error = resultError
    ? `${input.executorName}: ${resultError}`
    : detail;
  const summary = timeoutHint
    ? `${input.executorName} timed out — ${resultError || detail}`
    : error;

  return {
    summary: truncate(summary, 500),
    error: truncate(error, 500),
    kind: timeoutHint ? "timeout" : "failed",
  };
}
