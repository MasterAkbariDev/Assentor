import { z } from "zod";
import { isSecretPath, redactSecrets } from "../security/redact.js";

/**
 * Danger-area classifier (task T02B-07). Pure and deterministic: no I/O, no
 * clock, no model calls. Decides whether a task or change touches a danger area
 * (docs/tasks/README.md §1); Cascade (T02B-06) starts such tasks on the strong
 * tier with approval and the Lead (T02B-02) gives them extra scrutiny.
 *
 * Biased toward false positives: a missed danger area is the costly mistake.
 *
 * - Paths are repo-relative. They are normalised before matching: `\` becomes
 *   `/`, case is folded, `.`/`..` segments are resolved, and Windows trailing
 *   dots/spaces are trimmed, so `SRC\Process.\x.ts` and `docs/../src/process/x.ts`
 *   both hit `src/process`. A path that climbs above the root, starts at `~`, or
 *   uses a Windows short name or `:` stream is itself a `paths` danger.
 * - A rule glob matches at any depth and also matches everything under it:
 *   `git` matches `src/git/local.ts`. Globs support `*`, `?` and `**` and are
 *   matched without regular expressions, so a crafted path cannot cause ReDoS.
 * - Diffs: every path in `diff --git`, `---`/`+++`, `rename`/`copy` and
 *   `Binary files` lines is checked (both sides of a rename); added and removed
 *   lines are scanned with keyword patterns. Context lines and binary payloads
 *   are not scanned.
 * - Input over a size limit is scanned up to the limit and reported as the
 *   `unscanned` category, which makes the level `danger`, never `normal`.
 */

/** Built-in danger categories, in the order of the Danger list. */
export const DANGER_CATEGORIES = [
  "process",
  "git",
  "permissions",
  "secrets",
  "network",
  "shell",
  "paths",
  "release",
  "contracts",
  "config",
] as const;
export type DangerCategory = (typeof DANGER_CATEGORIES)[number];

/** Category reported when part of the input was too large to scan. Always danger. */
export const RISK_UNSCANNED = "unscanned";

export type RiskLevel = "normal" | "danger";

export const MAX_RISK_TASK_CHARS = 100_000;
export const MAX_RISK_DIFF_CHARS = 2_000_000;
export const MAX_RISK_PATHS = 5_000;
export const MAX_RISK_PATH_CHARS = 4_096;
/** Reasons kept in the result; further matches are counted in a final line. */
export const MAX_RISK_REASONS = 50;

export interface RiskInput {
  taskText?: string;
  /** Repo-relative paths the task touches or the change modified. */
  paths?: readonly string[];
  /** Unified diff (git or plain). */
  diff?: string;
}

/**
 * A user danger area (`modes.cascade.dangerAreas`). It only adds danger: there is
 * no way to switch a built-in rule off. Keywords are literal, whole-word and
 * case-insensitive (never regular expressions).
 */
export interface DangerAreaRule {
  /** Category name in the result; may reuse a built-in category id. */
  name: string;
  paths?: readonly string[];
  keywords?: readonly string[];
}

export interface RiskOptions {
  extraRules?: readonly DangerAreaRule[];
}

export interface RiskAssessment {
  level: RiskLevel;
  /** Built-in categories in Danger-list order, then `unscanned`, then custom names sorted. */
  categories: string[];
  /** Each reason cites the matched path, diff line or task phrase. */
  reasons: string[];
}

export const DangerAreaRuleSchema = z
  .object({
    name: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "use letters, digits, '.', '_' or '-' (max 64)"),
    paths: z.array(z.string().trim().min(1).max(256)).max(100).default([]),
    keywords: z.array(z.string().trim().min(2).max(100)).max(100).default([]),
  })
  .refine((rule) => rule.paths.length + rule.keywords.length > 0, {
    message: "a danger area needs at least one path or keyword",
  });

interface BuiltinRule {
  category: DangerCategory;
  paths: string[];
  /** Matched in task text and in changed diff lines. */
  text: RegExp[];
  /** Natural-language patterns, matched in task text only (too noisy for code). */
  task?: RegExp[];
  /** Secret values: the match is never quoted back in a reason. */
  secretValues?: RegExp[];
}

// Every pattern is linear-time: no nested or adjacent unbounded quantifiers over
// the same characters. Keep it that way when adding patterns (ReDoS).
const BUILTIN_RULES: BuiltinRule[] = [
  {
    category: "process",
    paths: ["process", "processes", "*spawn*", "kill-*", "kill_*", "kill.*", "pty", "node-pty", "*daemon*", "*supervisor*", "*executor*", "*lifecycle*"],
    text: [
      /\bchild_process\b/i,
      /\b(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/i,
      /\bexeca\b/i,
      /\bprocess\.kill\b|\.kill\s*\(/i,
      /\b(?:taskkill|pkill|killall)\b/i,
      /\bkill\s+-(?:9|KILL|TERM)\b/i,
      /\bSIG(?:KILL|TERM|INT|HUP)\b/,
      /\bdetached\s*:\s*true\b/i,
      /\bjob\s*objects?\b/i,
      /\bprocess\s+(?:trees?|groups?|lifecycle)\b/i,
    ],
    task: [
      /\b(?:spawn|kill|restart|interrupt|terminate)(?:s|ed|ing)?\s+(?:(?:the|a|an|all|child|running|agent|cli|seat)\s+){0,3}(?:process|processes|clis?|turns?|agents?|seats?|children)\b/i,
      /\bchild\s+process(?:es)?\b/i,
    ],
  },
  {
    category: "git",
    paths: ["git", ".git", "git-*", "*-git", "*-git.*", "*worktree*", ".gitmodules", ".gitattributes", ".gitignore", ".husky", ".githooks"],
    text: [
      /\bgit\s+(?:push|merge|rebase|reset|checkout|switch|stash|worktree|branch|clean|rm|commit|cherry-pick|revert|tag|update-ref|filter-branch|filter-repo|gc|prune|restore|am|apply|pull|clone|submodule|config|reflog)\b/i,
      /["'`](?:rebase|reset|checkout|stash|worktree|cherry-pick|update-ref|restore|filter-branch)["'`]/i,
      /\[\s*["'`](?:push|merge|switch|clean|branch|tag|commit|rm|am|apply|pull)["'`]/i,
      /--force(?:-with-lease)?\b|--hard\b|--no-verify\b/i,
      /\b(?:simple-git|isomorphic-git|nodegit|libgit2)\b/i,
      /\bworktrees?\b/i,
    ],
    task: [
      /\bgit\b/i,
      /\b(?:merge|rebase|rollback|roll\s+back|force[-\s]push|cherry[-\s]pick|stash)(?:es|ed|ing|s)?\b/i,
    ],
  },
  {
    category: "permissions",
    paths: ["*permission*", "*sandbox*", "*approval*", "*security*", "seats", "seats.ts", ".claude/settings*", ".claude/hooks", ".codex/config*", ".gemini/settings*", ".cursor/cli*", ".mcp.json"],
    text: [
      /--dangerously[-\w]*/i,
      /\byolo\b/i,
      /\bbypass[-_\s]?(?:approvals?|permissions?|sandbox(?:ing)?)\b/i,
      /\bskip[-_\s]?permissions?\b/i,
      /--full-auto\b|\bdanger-full-access\b|--sandbox\b|--approval-mode\b|--allow-all-tools\b|--trust\b/i,
      /\b(?:permission|approval)[-_]?(?:mode|policy|prompt)s?\b/i,
      /\bread[-_\s]only\b/i,
      /\b(?:allowed|disallowed)Tools\b/i,
    ],
    task: [/\bpermissions?\b/i, /\bbypass\w*/i, /\bsandbox\w*/i, /\bapprovals?\b/i, /\bedit\s+seats?\b/i],
  },
  {
    category: "secrets",
    paths: ["keys", "*apikey*", "*api-key*", "*api_key*", "*vault*", "*keychain*", "*keyring*", "*secret*", "*credential*", "*redact*", "*crypto*", "*encrypt*", ".env*", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.gpg", ".npmrc", ".pypirc", ".netrc", ".git-credentials", ".ssh", ".aws", ".gnupg", "id_*"],
    text: [
      /\b(?:keytar|keychain|keyring|libsecret|dpapi)\b/i,
      /\bsecurity\s+(?:find|add|delete)-(?:generic|internet)-password\b/i,
      /\bvault\b/i,
      /\bcredentials?\b/i,
      /api[-_\s]?keys?/i,
      /secret/i,
      /passw(?:or)?d/i,
      /private[-_\s]?key/i,
      /(?:access|auth|refresh|bearer|session|api|github|npm)[-_\s]?tokens?/i,
      /\bbearer\b/i,
      /\bredact/i,
      /\b(?:en|de)crypt/i,
      /process\.env\.[A-Z0-9_]*(?:KEY|TOKEN)\b/i,
    ],
    secretValues: [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\bsk-[A-Za-z0-9_-]{20,}/,
      /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/,
      /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /\bAIza[0-9A-Za-z_-]{35}/,
      /\bnpm_[A-Za-z0-9]{36}\b/,
    ],
  },
  {
    category: "network",
    paths: ["serve", "server", "servers", "server.*", "*-server*", "*_server*", "*websocket*", "ws", "rpc", "*auth*", "*cors*", "*listener*", "*gateway*", "*proxy*", "*webhook*", "src-tauri/capabilities"],
    text: [
      /\b(?:createServer|createSecureServer)\s*\(/i,
      /\.listen\s*\(/i,
      /\bWebSocket\.?Server\b|\bnew\s+WebSocket\b/i,
      /\b(?:express|fastify|koa|hono)\s*\(/i,
      /\bAccess-Control-Allow-/i,
      /\bcors\b/i,
      /\b(?:allowedOrigins?|checkOrigin|verifyClient|originAllowed)\b/i,
      /\bheaders?\s*(?:\.|\[\s*["'])origin\b/i,
      /\b0\.0\.0\.0\b/,
      /\bcontent-security-policy\b|\bcsp\b/i,
      /\bwss?:\/\//i,
      /\bauthorization\b/i,
    ],
    task: [
      /\bserv(?:e|er|ers)\b/i,
      /\bweb\s?sockets?\b/i,
      /\blisten(?:er|ers|ing)?\b/i,
      /\bports?\b/i,
      /\bauth(?:n|z|entication|enticate|orization|orize)?\b/i,
      /\b(?:log|sign)[-\s]?in\b/i,
      /\borigin\s+checks?\b/i,
      /\bendpoints?\b/i,
      /\btauri\s+(?:capabilit\w*|permissions?|allowlist)/i,
    ],
  },
  {
    category: "shell",
    paths: ["*shell*", "*recipe*", "*locator*", "*.sh", "*.bash", "*.zsh", "*.fish", "*.ps1", "*.psm1", "*.bat", "*.cmd", "*.exe", "*.dll", "*.so", "*.dylib", "*.node", "*.jar", "*.wasm", "makefile", "*.mk", "justfile"],
    text: [
      /\bshell\s*:\s*(?:true|["'])/i,
      /\b(?:bash|zsh|sh|fish|cmd|powershell|pwsh)(?:\.exe)?\s+(?:-l?c|-l|-i|\/[cdsk]|-command|-encodedcommand|-noprofile)\b/i,
      /["'](?:-lc|-c|\/c|\/d|-command)["']/i,
      /\$SHELL\b|\bprocess\.env\.SHELL\b|\bComSpec\b/i,
      /\blogin[-_\s]?shell\b/i,
      /\bprocess\.env\.PATH\b|\$PATH\b|%PATH%|\bPATHEXT\b/,
      /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.run\w*/i,
      /\b(?:curl|wget|Invoke-WebRequest|Invoke-Expression|iex)\b/i,
      /\bchmod\s+(?:\+x|[0-7]{3,4})\b/i,
    ],
    task: [
      /\bshells?\b/i,
      /\bPATH\b/,
      /\brecipes?\b/i,
      /\buser[-\s]defined\s+(?:clis?|commands?)\b/i,
      /\b(?:arbitrary|user)\s+commands?\b/i,
      /\bexecut(?:e|es|ing|ion)\s+(?:of\s+)?(?:commands?|scripts?|binar(?:y|ies))\b/i,
    ],
  },
  {
    category: "paths",
    paths: ["*path*", "*cleanup*", "*clean-up*", "*clean_up*", "*prune*", "*purge*", "*trash*", "*delete*", "*remove*", "*symlink*", "*traversal*"],
    text: [
      /\bfs\w*\.(?:rm|rmdir|unlink|remove|emptyDir)\w*\s*\(/i,
      /\b(?:rm|rmdir|unlink|rimraf)(?:Sync)?\s*\(/i,
      /\brm\s+-/,
      /\bRemove-Item\b|\b(?:rd|rmdir)\s+\/s\b|\bdel\s+\/[fsq]\b/i,
      /\bshutil\.rmtree\b|\bos\.(?:remove|unlink|rmdir)\b|\bFileUtils\.rm/i,
      /\bforce\s*:\s*true\b/i,
      /\ballowExternalPaths\b/i,
      /\b(?:realpath|symlink|readlink)\w*/i,
      /(?:safe|contained)(?:project)?path/i,
      /\bpath[-_\s]?traversal\b/i,
    ],
    task: [
      /\b(?:delete|deletes|deleting|remove|removes|removing|clean(?:\s|-)?up|cleaning\s+up|purge|wipe|prune|erase)\s+(?:\w+\s+){0,2}?(?:files?|dirs?|director(?:y|ies)|folders?|worktrees?|sessions?|data|caches?|logs?|branch(?:es)?|artifacts?|everything)\b/i,
      /\bcleanup\b/i,
      /\bpath\s+(?:policy|traversal|checks?|validation|containment|escapes?)\b/i,
      /\bsymlinks?\b/i,
      /\bexternal\s+paths?\b/i,
    ],
  },
  {
    category: "release",
    paths: [".github", ".gitlab-ci*", ".circleci", "azure-pipelines*", "jenkinsfile", ".buildkite", ".travis*", "scripts/install*", "scripts/uninstall*", "scripts/update*", "scripts/release*", "scripts/publish*", "install.sh", "install.ps1", "*release*", "*publish*", "*signing*", "*codesign*", "*notar*", "*.entitlements", "*updater*", "*update-manifest*", "*self-update*", "self", "bin", "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", ".yarnrc*", "bun.lockb", "dockerfile*", "*.dockerfile", "docker-compose*", ".goreleaser*", "cargo.toml", "cargo.lock", "pyproject.toml", "requirements*.txt", "go.mod", "go.sum", "src-tauri/tauri.conf*"],
    text: [
      /\b(?:codesign|signtool|notarytool|notarize|notarization|stapler|cosign|minisign|gpg)\b/i,
      /\b(?:npm|pnpm|yarn|cargo)\s+publish\b|\btwine\s+upload\b/i,
      /\$\{\{\s*secrets\./i,
      /\b(?:GITHUB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|APPLE_ID|APPLE_PASSWORD|TAURI_SIGNING_PRIVATE_KEY)\b/,
      /["'](?:pre|post)?install["']\s*:/i,
      /["'](?:prepare|prepublish\w*|postpublish)["']\s*:/i,
      /\bpull_request_target\b|\bwrite-all\b/i,
      /\b(?:auto|self)[-_\s]?updat\w*/i,
      /\bupdate[-_\s]?manifest\b/i,
    ],
    task: [
      /\breleas(?:e|es|ing)\b/i,
      /\bpublish\w*/i,
      /\b(?:code\s*)?sign(?:ing|ed)?\b/i,
      /\bnotari[sz]\w*/i,
      /\binstall(?:er|ers|\s+scripts?)\b/i,
      /\bupdat(?:er|e\s+(?:chain|manifest|channel))\b/i,
      /\bci\b/i,
      /\bgithub\s+actions?\b|\bworkflows?\s+(?:file|yaml|yml)\b/i,
      /\bdependenc(?:y|ies)\s+(?:bump|upgrade|update)|\b(?:add|bump|upgrade)\s+(?:a\s+|the\s+)?(?:npm\s+)?(?:dependency|dependencies|package)\b/i,
    ],
  },
  {
    category: "contracts",
    paths: ["*contract*", "*schema*", "*types*", "*.d.ts", "*protocol*", "*.proto", "openapi*", "swagger*", "*.graphql", "*.gql", "*.avsc"],
    text: [/\bbreaking\s+changes?\b/i],
    task: [
      /\bcontracts?\b/i,
      /\bschemas?\b/i,
      /\bprotocols?\b/i,
      /\bpublic\s+(?:api|interfaces?|types?)\b/i,
      /\bshared\s+(?:types?|interfaces?)\b/i,
      /\bwire\s+format\b/i,
    ],
  },
  {
    category: "config",
    paths: ["config", "configs", ".assentor", "config.yaml", "config.yml", "*migration*", "*migrate*"],
    text: [
      /~[/\\]\.assentor\b|\.assentor[/\\]config\b/i,
      /\bhomedir\s*\(/i,
      /\b(?:save|write|rewrite|migrate|update)\w*config\b/i,
      /\bmigrat(?:e|es|ed|ion|ions|ing)\b/i,
      /\bXDG_CONFIG_HOME\b|\bAPPDATA\b/,
    ],
    task: [
      /\bconfig(?:uration)?\s+(?:migration|rewrite|upgrade|format|files?|loader|loading|save|saving|writes?)\b/i,
      /\bconfig\.ya?ml\b/i,
      /\buser\s+config\w*/i,
    ],
  },
];

interface CompiledGlob {
  glob: string;
  segments: string[];
}

interface CompiledRule {
  category: string;
  globs: CompiledGlob[];
  text: RegExp[];
  task: RegExp[];
  secretValues: RegExp[];
}

/** `glob` matches at any depth and covers everything below it: `**​/glob/**`. */
function compileGlob(glob: string): CompiledGlob {
  const inner = glob.replace(/\\/g, "/").toLowerCase().split("/").filter((s) => s.length > 0 && s !== ".");
  return { glob, segments: ["**", ...inner, "**"] };
}

const COMPILED_BUILTINS: CompiledRule[] = BUILTIN_RULES.map((rule) => ({
  category: rule.category,
  globs: rule.paths.map(compileGlob),
  text: rule.text,
  task: rule.task ?? [],
  secretValues: rule.secretValues ?? [],
}));

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordRegExp(keyword: string): RegExp {
  const k = keyword.trim();
  const start = /^\w/.test(k) ? "(?<![A-Za-z0-9_])" : "";
  const end = /\w$/.test(k) ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(`${start}${escapeRegExp(k)}${end}`, "i");
}

function compileExtraRules(rules: readonly DangerAreaRule[]): CompiledRule[] {
  return rules.map((rule) => ({
    category: rule.name.trim().toLowerCase(),
    // A glob with no segments (".", "/") would match every path; skip it.
    globs: (rule.paths ?? []).map(compileGlob).filter((g) => g.segments.length > 2),
    text: (rule.keywords ?? []).filter((k) => k.trim().length > 0).map(keywordRegExp),
    task: [],
    secretValues: [],
  }));
}

/** `*` and `?` within one segment. Two-pointer match, O(len(p) * len(s)) worst case. */
function matchSegment(p: string, s: string): boolean {
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) {
      pi += 1;
      si += 1;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi;
      pi += 1;
      mark = si;
    } else if (star >= 0) {
      pi = star + 1;
      mark += 1;
      si = mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi += 1;
  return pi === p.length;
}

function globMatchesPath(glob: CompiledGlob, segments: readonly string[]): boolean {
  // Fast path for the common one-segment rule (`**/x/**`): any segment matches x.
  if (glob.segments.length === 3) {
    const only = glob.segments[1]!;
    return only === "**" || segments.some((s) => matchSegment(only, s));
  }
  return matchGlob(glob.segments, segments);
}

/** Segment-level glob match; `**` spans zero or more segments. O(P * S) segment matches. */
function matchGlob(pattern: readonly string[], segments: readonly string[]): boolean {
  const n = segments.length;
  let next: boolean[] = new Array<boolean>(n + 1).fill(false);
  next[n] = true;
  for (let i = pattern.length - 1; i >= 0; i -= 1) {
    const p = pattern[i]!;
    const cur: boolean[] = new Array<boolean>(n + 1).fill(false);
    for (let j = n; j >= 0; j -= 1) {
      cur[j] =
        p === "**"
          ? next[j]! || (j < n && cur[j + 1]!)
          : j < n && next[j + 1]! && matchSegment(p, segments[j]!);
    }
    next = cur;
  }
  return next[0]!;
}

function trimTrailing(segment: string, chars: string): string {
  let end = segment.length;
  while (end > 0 && chars.includes(segment[end - 1]!)) end -= 1;
  return segment.slice(0, end);
}

interface NormalizedPath {
  path: string;
  segments: string[];
}

/**
 * Lower-cased, `/`-separated, `.`/`..` resolved (leading `..` kept), Windows
 * trailing dots/spaces trimmed (Windows ignores them, so `process.` is `process`).
 */
function normalizeRiskPath(raw: string): NormalizedPath {
  const out: string[] = [];
  for (const part of raw.replace(/\\/g, "/").toLowerCase().split("/")) {
    const spaced = trimTrailing(part, " ");
    if (spaced === "" || spaced === ".") continue;
    if (spaced === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
      continue;
    }
    const trimmed = trimTrailing(spaced, ". ");
    if (trimmed !== "") out.push(trimmed);
  }
  return { path: out.join("/"), segments: out };
}

/** Collects reasons, one per (category, key), in scan order. */
class Findings {
  readonly categories = new Set<string>();
  readonly reasons: string[] = [];
  private readonly seen = new Set<string>();
  private dropped = 0;

  add(category: string, key: string, reason: string): void {
    const id = `${category}\u0000${key}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.categories.add(category);
    // Reasons quote agent-written text; drop control and bidi characters (terminal escapes).
    const safe = `${category}: ${reason}`.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?");
    if (this.reasons.length < MAX_RISK_REASONS) this.reasons.push(safe);
    else this.dropped += 1;
  }

  finish(): RiskAssessment {
    const builtin = new Map<string, number>(DANGER_CATEGORIES.map((c, i) => [c, i]));
    builtin.set(RISK_UNSCANNED, DANGER_CATEGORIES.length);
    const rank = (c: string) => builtin.get(c) ?? builtin.size;
    const categories = [...this.categories].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
    const reasons = [...this.reasons];
    if (this.dropped > 0) reasons.push(`… and ${this.dropped} more matches`);
    return { level: categories.length > 0 ? "danger" : "normal", categories, reasons };
  }
}

/** Shorten and redact a line before quoting it in a reason. */
function excerpt(line: string, index: number): string {
  const start = Math.max(0, index - 40);
  let text = line.slice(start, start + 120).trim();
  if (start > 0) text = `…${text}`;
  if (start + 120 < line.length) text = `${text}…`;
  return redactSecrets(text).text;
}

function quote(text: string): string {
  return JSON.stringify(text);
}

class Classifier {
  private readonly checkedPaths = new Set<string>();

  constructor(
    private readonly rules: readonly CompiledRule[],
    private readonly findings: Findings,
  ) {}

  /** Check one changed path: structure (escape, short names, streams) and every glob rule. */
  checkPath(raw: string, where: string): void {
    if (raw.length > MAX_RISK_PATH_CHARS) {
      this.findings.add(RISK_UNSCANNED, `path:${raw.slice(0, 200)}`, `${where} has a path of ${raw.length} chars, over the ${MAX_RISK_PATH_CHARS} limit; not checked`);
      return;
    }
    const norm = normalizeRiskPath(raw);
    if (norm.path === "" || this.checkedPaths.has(norm.path)) return;
    this.checkedPaths.add(norm.path);
    const cite = `${where} ${quote(norm.path)}`;

    if (norm.segments[0] === "..") {
      this.findings.add("paths", `path:${norm.path}`, `${cite} escapes the project root`);
    } else if (norm.segments[0] === "~") {
      this.findings.add("paths", `path:${norm.path}`, `${cite} points into the home directory`);
    }
    if (norm.segments.some((s) => /~\d/.test(s))) {
      this.findings.add("paths", `short:${norm.path}`, `${cite} looks like a Windows short (8.3) name, which can alias another path`);
    }
    if (norm.segments.some((s) => s.includes(":") && !/^[a-z]:$/.test(s))) {
      this.findings.add("paths", `stream:${norm.path}`, `${cite} contains ':' (alternate data stream or drive-relative path)`);
    }
    if (isSecretPath(norm.path)) {
      this.findings.add("secrets", `path:${norm.path}`, `${cite} is a secrets file`);
    }
    this.matchGlobs(norm, cite);
  }

  /** Glob rules only; for path-like words in task text, where structure checks would misfire on URLs. */
  matchGlobs(norm: NormalizedPath, cite: string): void {
    for (const rule of this.rules) {
      const hit = rule.globs.find((g) => globMatchesPath(g, norm.segments));
      if (hit) this.findings.add(rule.category, `path:${norm.path}`, `${cite} matches ${quote(hit.glob)}`);
    }
  }

  /**
   * Scan one file's changed lines. Each pattern runs once over the joined lines
   * (fast on big diffs); a hit is mapped back to its line for the citation. A
   * match may span a line break, which can only add danger.
   */
  checkChunk(chunk: Chunk): void {
    if (chunk.lines.length === 0) return;
    const text = chunk.lines.join("\n");
    const starts: number[] = [];
    let offset = 0;
    for (const line of chunk.lines) {
      starts.push(offset);
      offset += line.length + 1;
    }
    const lineAt = (index: number): number => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= index) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const key = `diff:${chunk.file}`;
    for (const rule of this.rules) {
      const secret = firstHit(rule.secretValues, text);
      if (secret) {
        this.findings.add(rule.category, key, `${citeLine(chunk, lineAt(secret.index))} contains a secret-like value`);
        continue;
      }
      const hit = firstHit(rule.text, text);
      if (!hit) continue;
      const k = lineAt(hit.index);
      const where = `${citeLine(chunk, k)} matches ${quote(redactSecrets(hit[0]).text)}`;
      this.findings.add(rule.category, key, `${where}: ${excerpt(chunk.lines[k]!, hit.index - starts[k]!)}`);
    }
  }

  checkTask(text: string): void {
    for (const rule of this.rules) {
      if (rule.secretValues.some((re) => re.test(text))) {
        this.findings.add(rule.category, "task:secret", "task text contains a secret-like value");
      }
      for (const re of [...rule.text, ...rule.task]) {
        const hit = re.exec(text);
        if (!hit) continue;
        const phrase = redactSecrets(hit[0]).text;
        this.findings.add(rule.category, `task:${phrase.toLowerCase()}`, `task text mentions ${quote(phrase)}`);
      }
    }
    // Paths named in the task, e.g. "fix src/process/kill-tree.ts".
    for (const token of text.split(/[\s`'"()[\]{},;<>]+/)) {
      if (token.length < 2 || token.length > MAX_RISK_PATH_CHARS) continue;
      if (!/[/\\]/.test(token) && !/\.[A-Za-z0-9]{1,10}$/.test(token)) continue;
      const norm = normalizeRiskPath(trimTrailing(token, ".:!?"));
      if (norm.path === "") continue;
      if (isSecretPath(norm.path)) {
        this.findings.add("secrets", `path:${norm.path}`, `task text names ${quote(norm.path)}, a secrets file`);
      }
      this.matchGlobs(norm, `task text names ${quote(norm.path)}, which`);
    }
  }

  checkDiff(diff: string): void {
    let chunk = newChunk("(diff)");
    const setFile = (next: string) => {
      if (next === chunk.file) return;
      this.checkChunk(chunk);
      chunk = newChunk(next);
    };
    let oldLine: number | undefined;
    let newLine: number | undefined;
    const lines = diff.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      let line = lines[i]!;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const first = line[0];

      if (first === " ") {
        if (oldLine !== undefined) oldLine += 1;
        if (newLine !== undefined) newLine += 1;
        continue;
      }
      // `---`/`+++` are file headers outside a hunk, but inside one they are content
      // lines. Treat them as both: checking an extra path only adds danger.
      if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        const raw = unquotePath(line.slice(4).split("\t")[0]!);
        if (raw !== "/dev/null") {
          const p = stripPrefix(raw);
          this.checkPath(p, "diff file path");
          if (first === "+") setFile(p);
        }
      }
      if (first === "+" || first === "-") {
        const fileLine = first === "+" ? newLine : oldLine;
        chunk.lines.push(line.slice(1));
        chunk.refs.push({ fileLine, diffLine: i + 1, sign: first });
        if (first === "+" && newLine !== undefined) newLine += 1;
        if (first === "-" && oldLine !== undefined) oldLine += 1;
        continue;
      }

      if (line.startsWith("diff --git ")) {
        const candidates = gitHeaderPaths(line.slice("diff --git ".length));
        for (const p of candidates) this.checkPath(p, "diff header path");
        setFile(candidates[candidates.length - 1] ?? chunk.file);
        oldLine = newLine = undefined;
      } else if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
        setFile(unquotePath(line.slice(line.indexOf(" ", 5) + 1)));
        this.checkPath(chunk.file, "diff header path");
        oldLine = newLine = undefined;
      } else if (line.startsWith("rename ") || line.startsWith("copy ")) {
        const renamed = /^(?:rename|copy) (?:from|to) /.exec(line);
        if (renamed) this.checkPath(unquotePath(line.slice(renamed[0].length)), `diff ${renamed[0].trim()}`);
      } else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
        const body = line.slice("Binary files ".length, -" differ".length);
        for (const p of splitCandidates(body, " and ")) this.checkPath(stripPrefix(unquotePath(p)), "binary diff path");
      } else if (line.startsWith("@@")) {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        oldLine = m ? Number(m[1]) : undefined;
        newLine = m ? Number(m[2]) : undefined;
      }
    }
    this.checkChunk(chunk);
  }
}

interface Chunk {
  file: string;
  /** Added and removed lines, without the +/- marker. */
  lines: string[];
  /** Where each entry of `lines` came from; turned into a citation only on a hit. */
  refs: Array<{ fileLine: number | undefined; diffLine: number; sign: string }>;
}

function newChunk(file: string): Chunk {
  return { file, lines: [], refs: [] };
}

function citeLine(chunk: Chunk, k: number): string {
  const ref = chunk.refs[k]!;
  return `${chunk.file}:${ref.fileLine ?? `diff line ${ref.diffLine}`} (${ref.sign})`;
}

/** First pattern (in rule order) that matches anywhere in `text`. */
function firstHit(patterns: readonly RegExp[], text: string): RegExpExecArray | undefined {
  for (const re of patterns) {
    const hit = re.exec(text);
    if (hit) return hit;
  }
  return undefined;
}

/** Splits at most 8 times; the whole string is always a candidate too (over-inclusive on purpose). */
function splitCandidates(text: string, separator: string): string[] {
  const out = [text];
  let at = text.indexOf(separator);
  for (let n = 0; at !== -1 && n < 8; n += 1) {
    out.push(text.slice(0, at), text.slice(at + separator.length));
    at = text.indexOf(separator, at + 1);
  }
  return out;
}

function stripPrefix(p: string): string {
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

/** `diff --git a/x b/y` (paths may hold spaces or be C-quoted). The b-side comes last. */
function gitHeaderPaths(rest: string): string[] {
  if (rest.startsWith('"')) {
    const first = readQuoted(rest);
    if (first) {
      const tail = rest.slice(first.end).trim();
      return [first.value, unquotePath(tail)].map(stripPrefix);
    }
  }
  // Over-inclusive: the whole remainder and each split; the b-side comes last.
  const out = splitCandidates(rest, rest.startsWith("a/") ? " b/" : " ");
  const quoted = rest.indexOf(' "');
  if (quoted > 0) out.push(unquotePath(rest.slice(quoted + 1)));
  return out.map(stripPrefix);
}

function unquotePath(text: string): string {
  return text.startsWith('"') ? (readQuoted(text)?.value ?? text) : text;
}

const C_ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };

/** Git C-style quoted path (`core.quotePath`): `"a/caf\303\251.ts"`. */
function readQuoted(text: string): { value: string; end: number } | undefined {
  const bytes: number[] = [];
  for (let i = 1; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === '"') return { value: Buffer.from(bytes).toString("utf8"), end: i + 1 };
    if (c === "\\" && i + 1 < text.length) {
      const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1, i + 4));
      if (octal) {
        bytes.push(parseInt(octal[0], 8) & 0xff);
        i += octal[0].length;
      } else {
        const next = text[i + 1]!;
        bytes.push(...Buffer.from(next in C_ESCAPES ? String.fromCharCode(C_ESCAPES[next]!) : next, "utf8"));
        i += 1;
      }
      continue;
    }
    bytes.push(...Buffer.from(c, "utf8"));
  }
  return undefined;
}

/**
 * Classify a task and/or change. `level` is `danger` when any category matched,
 * including `unscanned` (input over a size limit). Same input, same output.
 */
export function classifyRisk(input: RiskInput, options: RiskOptions = {}): RiskAssessment {
  const findings = new Findings();
  const rules = [...COMPILED_BUILTINS, ...compileExtraRules(options.extraRules ?? [])];
  const classifier = new Classifier(rules, findings);

  const paths = input.paths ?? [];
  if (paths.length > MAX_RISK_PATHS) {
    findings.add(RISK_UNSCANNED, "paths", `${paths.length} paths given, over the ${MAX_RISK_PATHS} limit; only the first ${MAX_RISK_PATHS} were checked`);
  }
  let diff = input.diff ?? "";
  if (diff.length > MAX_RISK_DIFF_CHARS) {
    findings.add(RISK_UNSCANNED, "diff", `diff is ${diff.length} chars, over the ${MAX_RISK_DIFF_CHARS} limit; only the first ${MAX_RISK_DIFF_CHARS} were scanned`);
    diff = diff.slice(0, MAX_RISK_DIFF_CHARS);
  }
  let task = input.taskText ?? "";
  if (task.length > MAX_RISK_TASK_CHARS) {
    findings.add(RISK_UNSCANNED, "task", `task text is ${task.length} chars, over the ${MAX_RISK_TASK_CHARS} limit; only the first ${MAX_RISK_TASK_CHARS} were scanned`);
    task = task.slice(0, MAX_RISK_TASK_CHARS);
  }

  for (const p of paths.slice(0, MAX_RISK_PATHS)) classifier.checkPath(String(p), "path");
  if (diff) classifier.checkDiff(diff);
  if (task) classifier.checkTask(task);
  return findings.finish();
}
