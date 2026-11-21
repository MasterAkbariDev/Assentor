import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { VaultSecretMirror } from "../../packages/engine/src/keys/vault.js";

export function createKeychainMirror(executable: string): VaultSecretMirror {
  async function call(op: string, root: string, id: string, secret?: string): Promise<{ ok?: boolean; secret?: string; missing?: boolean }> {
    const account = createHash("sha256").update(root).update("\0").update(id).digest("hex");
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ["--keychain-helper"], {
        windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
      });
      let output = "";
      const unavailable = () => reject(new Error("The OS keychain is unavailable"));
      const timer = setTimeout(() => {
        child.kill();
        unavailable();
      }, 4000);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        if (output.length > 32768) {
          child.kill();
          unavailable();
        }
      });
      child.once("error", () => { clearTimeout(timer); unavailable(); });
      child.stdin.on("error", unavailable);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          unavailable();
          return;
        }
        try { resolve(JSON.parse(output)); }
        catch { unavailable(); }
      });
      child.stdin.end(JSON.stringify({ op, account, ...(secret ? { secret } : {}) }));
    });
  }
  return {
    async get(root, id) { return (await call("get", root, id)).secret; },
    async set(root, id, secret) {
      if (!(await call("set", root, id, secret)).ok) throw new Error("The OS keychain could not save the credential");
    },
    async delete(root, id) {
      if (!(await call("delete", root, id)).ok) throw new Error("The OS keychain could not clear the credential");
    },
  };
}
