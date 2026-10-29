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
 * - Paths: NFKC-normalised, invisible (default-ignorable) characters removed,
 *   case-folded, `\` read as `/`, `.`/`..` resolved and Windows trailing
 *   dots/spaces trimmed, so `SRC\Process.\x.ts`, `src/proceſſ/x.ts` and
 *   `docs/../src/process/x.ts` all hit `src/process`. An absolute path (POSIX,
 *   drive letter or UNC) is a `paths` danger unless it lies inside `projectRoot`,
 *   in which case it is classified relative to the root. Paths that climb above
 *   the root, start at `~`, or use a Windows short name or `:` stream are
 *   `paths` dangers too.
 * - A rule glob matches at any depth and also matches everything under it:
 *   `git` matches `src/git/local.ts`. A bare name also matches a file of that
 *   name with an extension (`keys` matches `keys.tsx`). Globs support `*`, `?`
 *   and `**` and are matched without regular expressions under a work budget.
 * - Diffs: every path in `diff --git`, `---`/`+++`, `rename`/`copy` and
 *   `Binary files` lines is checked (both sides of a rename). Added and removed
 *   lines, the context lines of hunks with a change, and the function context
 *   after `@@ … @@` are scanned with keyword patterns. Modes count: a symlink
 *   (120000) is a `paths` danger and its target is checked as a path, a gitlink
 *   (160000) is `git` + `release`, a new 100755 mode is `shell`. Binary content
 *   is `unscanned` unless the file is plain media (png, jpg, … ttf) and not
 *   executable. Combined (`diff --cc`) and context (`diff -c`) diffs, and any
 *   line the parser does not recognise, are `unscanned`.
 * - Pass plain `git diff` output (no colour, no `--stat`). ANSI colour,
 *   `git show` commit headers and format-patch mail headers are lines the parser
 *   does not recognise, so they make the result `unscanned`.
 * - Input over a size limit is scanned up to the limit and reported as the
 *   `unscanned` category, which makes the level `danger`, never `normal`.
 * - Limits of keyword matching: it reads text, not semantics. Obfuscation such
 *   as `process['\x6bill']`, string-built module names or homoglyphs from other
 *   scripts (Cyrillic `е`) can defeat a pattern. A few obvious forms are caught
 *   (`process[`, non-literal `import(`/`require(`), but this is a triage signal,
 *   not a security boundary; reviewers still read the diff.
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
export const MAX_RISK_PATH_CHARS = 1_024;
export const MAX_RISK_PATH_SEGMENTS = 64;
/** Reasons kept in the result; further matches are counted in a final line. */
export const MAX_RISK_REASONS = 50;

export interface RiskInput {
  taskText?: string;
  /** Paths the task touches or the change modified; repo-relative, or absolute with `projectRoot`. */
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
  /**
   * Absolute project root. An absolute path inside it is classified relative to
   * it; any other absolute path (or any absolute path when this is unset) is a
   * `paths` danger.
   */
  projectRoot?: string;
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
    paths: z.array(z.string().trim().min(1).max(128)).max(50).default([]),
    keywords: z.array(z.string().trim().min(2).max(100)).max(50).default([]),
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
      // Aliased or promisified: `nodeSpawn(`, `execFileAsync(`. Bounded `\w` keeps it linear.
      /(?:spawn|execfile|execsync)\w{0,40}\s*\(/i,
      /\bexeca\b/i,
      /\bprocess\.kill\b|\.kill\s*\(/i,
      /\b(?:taskkill|pkill|killall)\b/i,
      /\bkill\s+-(?:9|KILL|TERM)\b/i,
      /\bSIG(?:KILL|TERM|INT|HUP)\b/,
      /\bdetached\s*:\s*true\b/i,
      /\bjob\s*objects?\b/i,
      /\bprocess\s*\[/,
      /\bnew\s+Worker\s*\(/,
      /\bprocess\.dlopen\b/,
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
      /\bSubproject commit [0-9a-f]/,
    ],
    task: [
      /\bgit\b/i,
      /\b(?:merge|rebase|rollback|roll\s+back|force[-\s]push|cherry[-\s]pick|stash)(?:es|ed|ing|s)?\b/i,
    ],
  },
  {
    category: "permissions",
    paths: ["*permission*", "*sandbox*", "*approval*", "*security*", "*danger*", "seats", ".claude/settings*", ".claude/hooks", ".codex/config*", ".gemini/settings*", ".cursor/cli*", ".mcp.json"],
    text: [
      /--dangerously[-\w]*/i,
      /\byolo\b/i,
      /\bbypass[-_\s]?(?:approvals?|permissions?|sandbox(?:ing)?)\b/i,
      /\bskip[-_\s]?permissions?\b/i,
      /--full-auto\b|\bdanger-full-access\b|--sandbox\b|--approval-mode\b|--allow-all-tools\b|--trust\b/i,
      /\b(?:permission|approval)[-_]?(?:mode|policy|prompt)s?\b/i,
      // `readOnly`, `isReadOnly`, `read-only`, `READ_ONLY`, `isReadonly`, `{ readonly: true }`,
      // `opts.readonly`, `{ readonly }`, "readonly"; not the TypeScript `readonly` keyword or `Readonly<T>`.
      /read[-_\s]only/i,
      /[rR]eadOnly|READONLY/,
      /[A-Za-z_]Readonly\b|\breadonly[\s?]*[:=,}]|\.readonly\b|["'`]readonly["'`]/,
      /\bpermissions?\s*:/i,
      /approv|autopilot|autonomy/i,
      /\b(?:allowed|disallowed)Tools\b/i,
    ],
    task: [/\bpermissions?\b/i, /\bbypass\w*/i, /\bsandbox\w*/i, /\bapprovals?\b/i, /\bedit\s+seats?\b/i, /\bread[-\s]?only\b/i, /\bdanger\w*/i],
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
      /\btimingSafeEqual\b/,
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
      /\b0\.0\.0\.0\b|["'](?:::|\[::\])["']/,
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
    paths: ["*shell*", "*recipe*", "*locator*", ".vscode", ".devcontainer", "*.sh", "*.bash", "*.zsh", "*.fish", "*.ps1", "*.psm1", "*.bat", "*.cmd", "*.exe", "*.dll", "*.so", "*.dylib", "*.node", "*.jar", "*.wasm", "makefile", "*.mk", "justfile"],
    text: [
      /\bshell\s*:/i,
      /\b(?:bash|zsh|sh|fish|cmd|powershell|pwsh)(?:\.exe)?\s+(?:-l?c|-l|-i|\/[cdsk]|-command|-encodedcommand|-noprofile)\b/i,
      /["'](?:-lc|-c|\/c|\/d|-command)["']/i,
      /\$SHELL\b|\bprocess\.env\.SHELL\b|\bComSpec\b/i,
      /\bprocess\.env\.(?:EDITOR|VISUAL)\b|\$EDITOR\b/,
      /\blogin[-_\s]?shell\b/i,
      /\bprocess\.env\.PATH\b|\$PATH\b|%PATH%|\bPATHEXT\b/,
      /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\./i,
      // Dynamic loading: a non-literal or concatenated specifier, or createRequire.
      /\b(?:import|require)\s*\(\s*[^'"`\s)]/,
      /\b(?:import|require)\s*\(\s*['"`][^'"`\n]*['"`]\s*\+/,
      /\bcreateRequire\b/,
      /\b(?:curl|wget|Invoke-WebRequest|Invoke-Expression|iex)\b/i,
      /\bchmod\s+(?:\+x|[0-7]{3,4})\b/i,
    ],
    task: [
      /\bshells?\b/i,
      /\bPATH\b/,
      /\brecipes?\b/i,
      /\buser[-\s]defined\s+(?:clis?|commands?)\b/i,
      /\b(?:arbitrary|user(?:'s)?)\s+(?:\w+\s+)?commands?\b/i,
      /\bplugins?\b/i,
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
      /guarded/i,
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
    paths: [".github", ".gitlab-ci*", ".circleci", "azure-pipelines*", "jenkinsfile", ".buildkite", ".travis*", "scripts/install*", "scripts/uninstall*", "scripts/update*", "scripts/release*", "scripts/publish*", "install.sh", "install.ps1", "*release*", "*publish*", "*signing*", "*codesign*", "*notar*", "*.entitlements", "*deploy*", "*updater*", "*update-manifest*", "*self-update*", "self", "bin", "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", ".yarnrc*", "bun.lockb", "dockerfile*", "*.dockerfile", "docker-compose*", ".goreleaser*", "cargo.toml", "cargo.lock", "pyproject.toml", "requirements*.txt", "go.mod", "go.sum", "setup.py", "build.rs", ".pnpmfile.cjs", "*.config.js", "*.config.cjs", "*.config.mjs", "*.config.ts", "*.config.mts", "src-tauri/tauri.conf*"],
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
      /\bSubproject commit [0-9a-f]/,
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

type SegmentTest = (segment: string, budget: Budget) => boolean;

interface CompiledGlob {
  glob: string;
  segments: string[];
  /** One test per entry of `segments` ("**" entries are handled by the matcher). */
  tests: SegmentTest[];
  /** Wildcard-free segments; a path lacking any of them cannot match (cheap prefilter). */
  literals: string[];
}

interface CompiledRule {
  category: string;
  globs: CompiledGlob[];
  /** Built-ins only: the rule's one-segment globs as a fast per-segment test. */
  segmentTest?: (name: string) => boolean;
  text: RegExp[];
  task: RegExp[];
  secretValues: RegExp[];
}

/** Default-ignorable code points (ZWSP, ZWJ, ZWNJ, soft hyphen, BOM, bidi marks, …). */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/** NFKC and default-ignorables stripped, so `proceſſ` and `pro​cess` read as `process`. Case is kept. */
function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(IGNORABLE, "");
}

/** Text normalisation plus full case folding, for paths and globs. */
function foldPath(text: string): string {
  return normalizeText(text).toUpperCase().toLowerCase().replace(/\\/g, "/");
}

/** `glob` matches at any depth and covers everything below it: `**​/glob/**`. */
function compileGlob(glob: string): CompiledGlob {
  // Trimmed like path segments (Windows ignores trailing dots/spaces), so `keys.` means `keys`.
  const inner = foldPath(glob)
    .split("/")
    .map((s) => (s === ".." ? s : trimTrailing(s, ". ")))
    .filter((s) => s.length > 0 && s !== ".");
  const segments = ["**", ...inner, "**"];
  return { glob, segments, tests: segments.map(segmentTest), literals: inner.filter((x) => !/[*?]/.test(x)) };
}

/**
 * Fast path for a built-in rule's one-segment globs. Each is a literal, `x*`,
 * `*x`, `*x*` or `x*y`; they become a set lookup plus literal alternations
 * (no quantifiers, so linear).
 */
function segmentFastTest(globs: readonly CompiledGlob[]): ((name: string) => boolean) | undefined {
  const literals = new Set<string>();
  const prefixes: string[] = [];
  const suffixes: string[] = [];
  const infixes: string[] = [];
  const pairs: Array<[string, string]> = [];
  for (const g of globs) {
    if (g.segments.length !== 3) continue;
    const parts = g.segments[1]!.split("*");
    if (g.segments[1]!.includes("?") || parts.length > 3) throw new Error(`built-in glob too complex for the fast path: ${g.glob}`);
    if (parts.length === 1) literals.add(parts[0]!);
    else if (parts.length === 3 && parts[0] === "" && parts[2] === "") infixes.push(parts[1]!);
    else if (parts.length === 2 && parts[0] === "") suffixes.push(parts[1]!);
    else if (parts.length === 2 && parts[1] === "") prefixes.push(parts[0]!);
    else if (parts.length === 2) pairs.push([parts[0]!, parts[1]!]);
    else throw new Error(`built-in glob shape not supported by the fast path: ${g.glob}`);
  }
  const alt = (list: string[]) => list.map(escapeRegExp).join("|");
  const infix = infixes.length > 0 ? new RegExp(alt(infixes)) : undefined;
  const prefix = prefixes.length > 0 ? new RegExp(`^(?:${alt(prefixes)})`) : undefined;
  const suffix = suffixes.length > 0 ? new RegExp(`(?:${alt(suffixes)})$`) : undefined;
  if (literals.size + infixes.length + prefixes.length + suffixes.length + pairs.length === 0) return undefined;
  return (name) =>
    literals.has(name) ||
    (infix?.test(name) ?? false) ||
    (prefix?.test(name) ?? false) ||
    (suffix?.test(name) ?? false) ||
    pairs.some(([head, tail]) => name.length >= head.length + tail.length && name.startsWith(head) && name.endsWith(tail));
}

const COMPILED_BUILTINS: CompiledRule[] = BUILTIN_RULES.map((rule) => ({
  category: rule.category,
  globs: rule.paths.map(compileGlob),
  segmentTest: segmentFastTest(rule.paths.map(compileGlob)),
  text: rule.text,
  task: rule.task ?? [],
  secretValues: rule.secretValues ?? [],
}));

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All of a rule's keywords as one literal, whole-word, case-insensitive alternation. */
function keywordsRegExp(keywords: readonly string[]): RegExp[] {
  const parts = keywords
    .map((keyword) => normalizeText(keyword).trim())
    .filter((k) => k.length > 0)
    .map((k) => {
      const start = /^\w/.test(k) ? "(?<![A-Za-z0-9_])" : "";
      const end = /\w$/.test(k) ? "(?![A-Za-z0-9_])" : "";
      return `${start}${escapeRegExp(k)}${end}`;
    });
  return parts.length > 0 ? [new RegExp(parts.join("|"), "i")] : [];
}

function compileExtraRules(rules: readonly DangerAreaRule[]): CompiledRule[] {
  return rules.map((rule) => ({
    category: rule.name.trim().toLowerCase(),
    // A glob with no segments (".", "/") would match every path; skip it.
    globs: (rule.paths ?? []).map(compileGlob).filter((g) => g.segments.length > 2),
    text: keywordsRegExp(rule.keywords ?? []),
    task: [],
    secretValues: [],
  }));
}

/** Distinct path-like words in task text that are checked against path rules. */
const MAX_TASK_PATH_TOKENS = 200;

/** Glob-matching work allowed per call; past it the remaining paths are `unscanned`. */
const GLOB_STEP_BUDGET = 8_000_000;

interface Budget {
  left: number;
}

/**
 * Literal and one-`*` segments (`git`, `*.sh`, `kill-*`, `*spawn*`) use native
 * string tests, charged by length; anything else uses the step-charged matcher.
 */
function segmentTest(p: string): SegmentTest {
  const cost = (s: string) => 1 + (s.length >> 3);
  if (!/[*?]/.test(p)) {
    return (s, b) => {
      b.left -= cost(s);
      return s === p;
    };
  }
  if (!p.includes("?")) {
    const parts = p.split("*");
    if (parts.length === 2) {
      const [head, tail] = parts as [string, string];
      return (s, b) => {
        b.left -= cost(s);
        return s.length >= head.length + tail.length && s.startsWith(head) && s.endsWith(tail);
      };
    }
    if (parts.length === 3 && parts[0] === "" && parts[2] === "") {
      const middle = parts[1]!;
      return (s, b) => {
        b.left -= cost(s);
        return s.includes(middle);
      };
    }
  }
  return (s, b) => matchSegment(p, s, b);
}

/** `*` and `?` within one segment. Two-pointer match; every step is charged to `budget`. */
function matchSegment(p: string, s: string, budget: Budget): boolean {
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (--budget.left < 0) return false;
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

/** A segment matches by its full name or by its name without the last extension (`keys` ~ `keys.tsx`). */
function matchName(test: SegmentTest, segment: string, stem: string, budget: Budget): boolean {
  return test(segment, budget) || (stem !== segment && test(stem, budget));
}

function globMatchesPath(glob: CompiledGlob, path: NormalizedPath, budget: Budget): boolean {
  const { segments, stems } = path;
  // Fast path for the common one-segment rule (`**/x/**`): any segment matches x.
  if (glob.segments.length === 3) {
    const test = glob.tests[1]!;
    return glob.segments[1] === "**" || path.unique.some((i) => matchName(test, segments[i]!, stems[i]!, budget));
  }
  if (glob.literals.some((l) => !path.names.has(l))) return false;
  const pattern = glob.segments;
  const n = segments.length;
  let next: boolean[] = new Array<boolean>(n + 1).fill(false);
  next[n] = true;
  for (let i = pattern.length - 1; i >= 0; i -= 1) {
    const p = pattern[i]!;
    const test = glob.tests[i]!;
    const cur: boolean[] = new Array<boolean>(n + 1).fill(false);
    for (let j = n; j >= 0; j -= 1) {
      cur[j] =
        p === "**"
          ? next[j]! || (j < n && cur[j + 1]!)
          : j < n && next[j + 1]! && matchName(test, segments[j]!, stems[j]!, budget);
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
  /** Folded, `/`-joined segments (without the root). */
  path: string;
  segments: string[];
  /** Each segment without its last extension. */
  stems: string[];
  /** Index of the first occurrence of each distinct segment (repeats need no second test). */
  unique: number[];
  /** Every segment and stem, for the literal prefilter. */
  names: Set<string>;
  /** "" for a relative path, "/" for POSIX or UNC, or a drive such as "c:". */
  root: string;
}

/**
 * Unicode-normalised and case-folded, `/`-separated, `.`/`..` resolved, Windows
 * trailing dots/spaces trimmed (Windows ignores them, so `process.` is `process`).
 * A relative path keeps leading `..`; an absolute one cannot climb above its root.
 */
function normalizeRiskPath(raw: string): NormalizedPath {
  let text = foldPath(raw);
  let root = "";
  const drive = /^[a-z]:/.exec(text);
  if (drive) {
    root = drive[0];
    text = text.slice(2);
  } else if (text.startsWith("/")) {
    root = "/";
  }
  const out: string[] = [];
  for (const part of text.split("/")) {
    const spaced = trimTrailing(part, " ");
    if (spaced === "" || spaced === ".") continue;
    if (spaced === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (root === "") out.push("..");
      continue;
    }
    const trimmed = trimTrailing(spaced, ". ");
    if (trimmed !== "") out.push(trimmed);
  }
  return withStems(out, root);
}

function withStems(segments: string[], root: string): NormalizedPath {
  const stems = segments.map((s) => {
    const dot = s.lastIndexOf(".");
    return dot > 0 ? s.slice(0, dot) : s;
  });
  const seen = new Set<string>();
  const unique: number[] = [];
  segments.forEach((s, i) => {
    if (!seen.has(s)) {
      seen.add(s);
      unique.push(i);
    }
  });
  return { path: segments.join("/"), segments, stems, unique, names: new Set([...segments, ...stems]), root };
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
    // Reasons quote agent-written text: drop controls, bidi and other invisible characters.
    const safe = `${category}: ${reason}`.replace(/[\p{Cc}\p{Default_Ignorable_Code_Point}]/gu, "?");
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

/** Binary files whose content may go unscanned: plain media and fonts, never executable. */
const MEDIA_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "woff", "woff2", "ttf"]);

/** What the extended git headers of one `diff --git` section said. */
interface Section {
  file: string;
  executable: boolean;
  symlink: boolean;
}

class Classifier {
  private readonly checkedPaths = new Set<string>();
  private readonly budget: Budget = { left: GLOB_STEP_BUDGET };
  private readonly root: NormalizedPath | undefined;

  constructor(
    private readonly rules: readonly CompiledRule[],
    private readonly findings: Findings,
    projectRoot: string | undefined,
  ) {
    this.root = projectRoot ? normalizeRiskPath(projectRoot) : undefined;
  }

  private unscanned(key: string, reason: string): void {
    this.findings.add(RISK_UNSCANNED, key, reason);
  }

  /** Check one changed path: structure (absolute, escape, short names, streams) and every glob rule. */
  checkPath(raw: string, where: string): void {
    // Out of matching budget: the result is already `unscanned`; stop spending time.
    if (this.budget.left < 0) return;
    if (raw.length > MAX_RISK_PATH_CHARS) {
      this.unscanned(`path:${raw.slice(0, 200)}`, `${where} has a path of ${raw.length} chars, over the ${MAX_RISK_PATH_CHARS} limit; not checked`);
      return;
    }
    let norm = normalizeRiskPath(raw);
    if (norm.segments.length > MAX_RISK_PATH_SEGMENTS) {
      this.unscanned(`path:${norm.path.slice(0, 200)}`, `${where} has ${norm.segments.length} segments, over the ${MAX_RISK_PATH_SEGMENTS} limit; not checked`);
      return;
    }
    const id = norm.root === "" ? norm.path : norm.root === "/" ? `/${norm.path}` : `${norm.root}/${norm.path}`;
    if (id === "" || this.checkedPaths.has(id)) return;
    this.checkedPaths.add(id);
    const cite = `${where} ${quote(id)}`;

    if (norm.root !== "") {
      const inside = this.relativeToRoot(norm);
      if (inside) {
        norm = inside;
      } else {
        this.findings.add(
          "paths",
          `abs:${id}`,
          this.root ? `${cite} is outside the project root` : `${cite} is absolute (no project root given to resolve it)`,
        );
      }
    }
    if (norm.segments[0] === "..") {
      this.findings.add("paths", `path:${id}`, `${cite} escapes the project root`);
    } else if (norm.segments[0] === "~") {
      this.findings.add("paths", `path:${id}`, `${cite} points into the home directory`);
    }
    if (norm.segments.some((s) => /~\d/.test(s))) {
      this.findings.add("paths", `short:${id}`, `${cite} looks like a Windows short (8.3) name, which can alias another path`);
    }
    if (norm.segments.some((s) => s.includes(":"))) {
      this.findings.add("paths", `stream:${id}`, `${cite} contains ':' (alternate data stream or drive-relative path)`);
    }
    if (isSecretPath(norm.path)) {
      this.findings.add("secrets", `path:${id}`, `${cite} is a secrets file`);
    }
    this.matchGlobs(norm, cite, id);
  }

  /**
   * The path relative to `projectRoot` when it lies inside it, else undefined.
   * Case-insensitive (paths are folded), so on a case-sensitive disk it errs toward "inside".
   */
  private relativeToRoot(norm: NormalizedPath): NormalizedPath | undefined {
    const root = this.root;
    if (!root || root.root !== norm.root || norm.segments.length < root.segments.length) return undefined;
    if (!root.segments.every((s, i) => norm.segments[i] === s)) return undefined;
    return withStems(norm.segments.slice(root.segments.length), "");
  }

  /** Glob rules only; for path-like words in task text, where structure checks would misfire on URLs. */
  matchGlobs(norm: NormalizedPath, cite: string, id = norm.path): void {
    for (const rule of this.rules) {
      if (this.budget.left < 0) break;
      let globs = rule.globs;
      if (rule.segmentTest) {
        const test = rule.segmentTest;
        const fast = norm.unique.some((i) => {
          const segment = norm.segments[i]!;
          const stem = norm.stems[i]!;
          this.budget.left -= 3 + (segment.length >> 3);
          return test(segment) || (stem !== segment && test(stem));
        });
        // On a fast-path miss only the multi-segment globs are left to try.
        if (!fast) globs = globs.filter((g) => g.segments.length !== 3);
      }
      const hit = globs.find((g) => globMatchesPath(g, norm, this.budget));
      if (hit) this.findings.add(rule.category, `path:${id}`, `${cite} matches ${quote(hit.glob)}`);
    }
    if (this.budget.left < 0) {
      this.unscanned("budget", `path matching ran out of its work budget at ${cite}; later paths were not fully checked`);
    }
  }

  /**
   * Scan one file's changed lines and the context of changed hunks. Each pattern
   * runs once over the joined lines; a hit is mapped back to its line for the
   * citation. A match may span a line break, which can only add danger.
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
    const tokens = new Set<string>();
    for (const token of text.split(/[\s`'"()[\]{},;<>]+/)) {
      if (token.length < 2 || token.length > MAX_RISK_PATH_CHARS) continue;
      if (!/[/\\]/.test(token) && !/\.[A-Za-z0-9]{1,10}$/.test(token)) continue;
      if (tokens.has(token)) continue;
      if (tokens.size >= MAX_TASK_PATH_TOKENS) {
        this.unscanned("task paths", `task text names more than ${MAX_TASK_PATH_TOKENS} distinct paths; the rest were not checked`);
        break;
      }
      tokens.add(token);
      const norm = normalizeRiskPath(trimTrailing(token, ".:!?"));
      if (norm.path === "" || norm.segments.length > MAX_RISK_PATH_SEGMENTS) continue;
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
    let section: Section = { file: "(diff)", executable: false, symlink: false };
    let oldLine: number | undefined;
    let newLine: number | undefined;
    /** Open hunk: context waits in `pending` until the hunk shows a change. */
    let hunk: { changed: boolean; pending: Array<{ line: string; ref: LineRef }> } | undefined;
    let inBinaryPatch = false;

    const push = (line: string, ref: LineRef) => {
      chunk.lines.push(line);
      chunk.refs.push(ref);
    };
    const binary = (fallback: string) => {
      const file = section.file !== "(diff)" ? section.file : fallback;
      const name = normalizeRiskPath(file).segments.at(-1) ?? "";
      const dot = name.lastIndexOf(".");
      const media = dot > 0 && MEDIA_EXTENSIONS.has(name.slice(dot + 1));
      if (!media || section.executable) {
        const why = media ? "an executable binary" : "binary";
        this.unscanned(`binary:${file}`, `${quote(file)} is ${why}; its content was not scanned`);
      }
    };
    const fileMode = (mode: string, isNew: boolean, where: string) => {
      const cite = `${quote(section.file)} (${where})`;
      if (mode === "120000") {
        section.symlink = true;
        this.findings.add("paths", `symlink:${section.file}`, `${cite} is a symlink`);
      } else if (mode === "160000") {
        this.findings.add("git", `gitlink:${section.file}`, `${cite} is a submodule (gitlink)`);
        this.findings.add("release", `gitlink:${section.file}`, `${cite} is a submodule (gitlink)`);
      } else if (mode === "100755") {
        section.executable = true;
        if (isNew) this.findings.add("shell", `exec:${section.file}`, `${cite} is made executable`);
      }
    };

    const lines = diff.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      let line = lines[i]!;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (inBinaryPatch && !line.startsWith("diff --git ")) {
        // Only `literal`/`delta` headers, base85 data and blank lines belong here; anything
        // else (e.g. text headers hidden after a media file's patch) is unscanned.
        if (line !== "" && !/^(?:literal|delta) \d+$/.test(line) && !/^[A-Za-z][0-9A-Za-z!#$%&()*+\-;<=>?@^_`{|}~]*$/.test(line)) {
          this.unscanned(`binary-region:${section.file}`, `diff line ${i + 1} sits inside the binary patch of ${quote(section.file)} but is not binary data; not scanned`);
        }
        continue;
      }
      const first = line[0];

      if (first === " " || (line === "" && hunk)) {
        if (hunk) {
          const ref: LineRef = { fileLine: newLine, diffLine: i + 1, sign: " " };
          if (hunk.changed) push(line.slice(1), ref);
          else hunk.pending.push({ line: line.slice(1), ref });
        }
        if (oldLine !== undefined) oldLine += 1;
        if (newLine !== undefined) newLine += 1;
        continue;
      }
      if (line === "" || first === "\\") continue;

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
        if (hunk && !hunk.changed) {
          hunk.changed = true;
          for (const pending of hunk.pending) push(pending.line, pending.ref);
          hunk.pending = [];
        }
        const content = line.slice(1);
        push(content, { fileLine: first === "+" ? newLine : oldLine, diffLine: i + 1, sign: first });
        if (first === "+" && section.symlink && !line.startsWith("+++ ")) {
          this.checkPath(linkTarget(section.file, content), `symlink ${quote(section.file)} points to`);
        }
        if (first === "+" && newLine !== undefined) newLine += 1;
        if (first === "-" && oldLine !== undefined) oldLine += 1;
        continue;
      }

      // Any other line is a header and closes the hunk.
      hunk = undefined;
      let m: RegExpExecArray | null;
      if (line.startsWith("diff --git ")) {
        inBinaryPatch = false;
        const candidates = gitHeaderPaths(line.slice("diff --git ".length));
        for (const p of candidates) this.checkPath(p, "diff header path");
        const file = candidates[candidates.length - 1] ?? chunk.file;
        section = { file, executable: false, symlink: false };
        setFile(file);
        oldLine = newLine = undefined;
      } else if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
        const file = unquotePath(line.slice(line.indexOf(" ", 5) + 1));
        section = { file, executable: false, symlink: false };
        setFile(file);
        this.checkPath(file, "diff header path");
        this.unscanned(`combined:${file}`, `${quote(file)} is a combined (merge) diff, which is not scanned`);
      } else if (line.startsWith("@@@")) {
        this.unscanned(`combined:${chunk.file}`, `${quote(chunk.file)} is a combined (merge) diff, which is not scanned`);
      } else if ((m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line))) {
        oldLine = Number(m[1]);
        newLine = Number(m[2]);
        hunk = { changed: false, pending: [] };
        // Function context after the second `@@`, e.g. `@@ -1,4 +1,4 @@ spawn(bin, args, {`.
        const context = line.slice(m[0].length).trim();
        if (context) hunk.pending.push({ line: context, ref: { fileLine: undefined, diffLine: i + 1, sign: "@@" } });
      } else if ((m = /^(new file mode|new mode|old mode|deleted file mode) ([0-7]{6})$/.exec(line))) {
        fileMode(m[2]!, m[1] === "new file mode" || m[1] === "new mode", m[1]!);
      } else if ((m = /^index [0-9a-f]+(?:,[0-9a-f]+)*\.\.[0-9a-f]+(?: ([0-7]{6}))?$/.exec(line))) {
        if (m[1]) fileMode(m[1], false, "index");
      } else if ((m = /^(?:rename|copy) (?:from|to) /.exec(line))) {
        this.checkPath(unquotePath(line.slice(m[0].length)), `diff ${m[0].trim()}`);
      } else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
        const body = line.slice("Binary files ".length, -" differ".length);
        const candidates = splitCandidates(body, " and ")
          .map((p) => stripPrefix(unquotePath(p)))
          .filter((p) => !p.startsWith("/dev/null"));
        for (const p of candidates) this.checkPath(p, "binary diff path");
        binary(candidates[candidates.length - 1] ?? body);
      } else if (line === "GIT binary patch") {
        inBinaryPatch = true;
        binary(section.file);
      } else if (!/^(?:similarity index|dissimilarity index) \d+%$/.test(line)) {
        // Context diffs (`diff -c`), mail headers and anything else we cannot parse.
        this.unscanned(`unparsed:${chunk.file}`, `diff line ${i + 1} is not in a format the classifier reads (${quote(line.slice(0, 60))}); the change was not fully scanned`);
      }
    }
    this.checkChunk(chunk);
  }
}

interface LineRef {
  fileLine: number | undefined;
  diffLine: number;
  /** "+", "-", " " (context) or "@@" (hunk-header function context). */
  sign: string;
}

interface Chunk {
  file: string;
  /** Scanned lines: changes, and context of changed hunks, without the marker. */
  lines: string[];
  /** Where each entry of `lines` came from; turned into a citation only on a hit. */
  refs: LineRef[];
}

function newChunk(file: string): Chunk {
  return { file, lines: [], refs: [] };
}

function citeLine(chunk: Chunk, k: number): string {
  const ref = chunk.refs[k]!;
  if (ref.sign === "@@") return `${chunk.file} hunk header (diff line ${ref.diffLine})`;
  const where = ref.fileLine ?? `diff line ${ref.diffLine}`;
  return `${chunk.file}:${where} (${ref.sign === " " ? "context" : ref.sign})`;
}

/** A symlink's target, resolved against the link's directory unless it is absolute. */
function linkTarget(linkFile: string, target: string): string {
  const t = target.trim();
  if (/^(?:[A-Za-z]:)?[/\\]/.test(t) || t.startsWith("~")) return t;
  const slash = linkFile.lastIndexOf("/");
  return slash >= 0 ? `${linkFile.slice(0, slash)}/${t}` : t;
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

/** Cut normalised text back to `max` chars, reporting `unscanned` when it had to. */
function capText(text: string, max: number, what: string, findings: Findings): string {
  if (text.length <= max) return text;
  findings.add(RISK_UNSCANNED, what, `${what} is ${text.length} chars, over the ${max} limit; only the first ${max} were scanned`);
  return text.slice(0, max);
}

/**
 * Classify a task and/or change. `level` is `danger` when any category matched,
 * including `unscanned` (input over a size limit or in a format it cannot read).
 * Same input, same output.
 */
export function classifyRisk(input: RiskInput, options: RiskOptions = {}): RiskAssessment {
  const findings = new Findings();
  const rules = [...COMPILED_BUILTINS, ...compileExtraRules(options.extraRules ?? [])];
  const classifier = new Classifier(rules, findings, options.projectRoot);

  const paths = input.paths ?? [];
  if (paths.length > MAX_RISK_PATHS) {
    findings.add(RISK_UNSCANNED, "paths", `${paths.length} paths given, over the ${MAX_RISK_PATHS} limit; only the first ${MAX_RISK_PATHS} were checked`);
  }
  // Cap before and after normalising: NFKC can lengthen text.
  const diff = capText(normalizeText(capText(input.diff ?? "", MAX_RISK_DIFF_CHARS, "diff", findings)), MAX_RISK_DIFF_CHARS, "diff", findings);
  const task = capText(normalizeText(capText(input.taskText ?? "", MAX_RISK_TASK_CHARS, "task text", findings)), MAX_RISK_TASK_CHARS, "task text", findings);

  for (const p of paths.slice(0, MAX_RISK_PATHS)) classifier.checkPath(String(p), "path");
  if (diff) classifier.checkDiff(diff);
  if (task) classifier.checkTask(task);
  return findings.finish();
}
