export interface RedactionResult {
  text: string;
  redacted: boolean;
  matches: number;
}

const DEFAULT_PATTERNS: RegExp[] = [
  // .env style assignments
  /\b(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|AWS_SECRET_ACCESS_KEY)\b\s*[=:]\s*['"]?[^\s'"]+/gi,
  // Bearer tokens
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // Generic high-entropy secrets (conservative)
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

export const SECRET_PATH_GLOBS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "credentials.*",
  "secrets.*",
  "id_rsa",
  "id_ed25519",
];

/**
 * Returns true when a relative path looks like a secrets file.
 */
export function isSecretPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;

  if (base === ".env" || base.startsWith(".env.")) {
    return true;
  }
  if (base.endsWith(".pem") || base.endsWith(".key")) {
    return true;
  }
  if (/^credentials(\.|$)/i.test(base) || /^secrets(\.|$)/i.test(base)) {
    return true;
  }
  if (base === "id_rsa" || base === "id_ed25519") {
    return true;
  }
  return false;
}

/**
 * Redacts common secret patterns from text sent to reviewers.
 */
export function redactSecrets(
  input: string,
  patterns: RegExp[] = DEFAULT_PATTERNS,
): RedactionResult {
  let text = input;
  let matches = 0;

  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g")
      ? pattern.flags
      : `${pattern.flags}g`;
    const global = new RegExp(pattern.source, flags);
    text = text.replace(global, (match) => {
      matches += 1;
      return "[REDACTED]";
    });
  }

  return {
    text,
    redacted: matches > 0,
    matches,
  };
}
