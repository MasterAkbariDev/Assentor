import { describe, expect, it } from "vitest";
import {
  assertCommandAllowed,
  assertSafeProjectPath,
  CommandPolicyError,
  isSecretPath,
  PathSecurityError,
  redactSecrets,
} from "../../src/index.js";

describe("security", () => {
  describe("paths", () => {
    it("resolves safe relative paths", () => {
      const resolved = assertSafeProjectPath("/proj", "src/a.ts");
      expect(resolved).toBe("/proj/src/a.ts");
    });

    it("rejects traversal and absolute paths", () => {
      expect(() => assertSafeProjectPath("/proj", "../etc/passwd")).toThrow(
        PathSecurityError,
      );
      expect(() => assertSafeProjectPath("/proj", "/etc/passwd")).toThrow(
        PathSecurityError,
      );
    });
  });

  describe("commands", () => {
    it("allows common safe commands", () => {
      expect(() => assertCommandAllowed("npm test")).not.toThrow();
      expect(() => assertCommandAllowed("git status")).not.toThrow();
      expect(() => assertCommandAllowed("pnpm vitest run")).not.toThrow();
    });

    it("blocks dangerous and unknown commands", () => {
      expect(() => assertCommandAllowed("rm -rf /")).toThrow(CommandPolicyError);
      expect(() => assertCommandAllowed("git reset --hard")).toThrow(
        CommandPolicyError,
      );
      expect(() => assertCommandAllowed("python exploit.py")).toThrow(
        CommandPolicyError,
      );
    });
  });

  describe("redaction", () => {
    it("redacts secrets from text", () => {
      const result = redactSecrets(
        "API_KEY=sk-abc12345678901234567890 and Bearer tok_value_here_123",
      );
      expect(result.redacted).toBe(true);
      expect(result.text).toContain("[REDACTED]");
      expect(result.text).not.toContain("sk-abc");
    });

    it("detects secret file paths", () => {
      expect(isSecretPath(".env")).toBe(true);
      expect(isSecretPath(".env.local")).toBe(true);
      expect(isSecretPath("certs/prod.pem")).toBe(true);
      expect(isSecretPath("src/app.ts")).toBe(false);
    });
  });
});
