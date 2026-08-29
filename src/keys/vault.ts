import { promises as fs } from "node:fs";
import path from "node:path";
import { createId } from "../core/ids.js";
import { ASSENTOR_DIR } from "../persistence/paths.js";
import type { AIProvider, ApiKeyRef, KeyStatus } from "../providers/ai/types.js";
import {
  decryptSecret,
  encryptSecret,
  getOrCreateMasterKey,
  maskSecret,
} from "./crypto.js";

export type KeyHealth = "healthy" | "degraded" | "cooldown" | "failed" | "unknown";

export interface StoredApiKey {
  id: string;
  provider: string;
  name: string;
  masked: string;
  ciphertext: string;
  enabled: boolean;
  priority: number;
  health: KeyHealth;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  failureCount: number;
  cooldownUntil?: string;
  lastCheckMessage?: string;
}

export interface KeyVaultFile {
  version: 1;
  keys: StoredApiKey[];
}

export class KeyVault {
  private masterKey?: Buffer;
  private data: KeyVaultFile = { version: 1, keys: [] };
  private readonly filePath: string;

  constructor(private readonly projectPath: string) {
    this.filePath = path.join(
      path.resolve(projectPath),
      ASSENTOR_DIR,
      "secrets.json",
    );
  }

  private async ensureMasterKey(): Promise<Buffer> {
    if (!this.masterKey) {
      this.masterKey = await getOrCreateMasterKey(this.projectPath);
    }
    return this.masterKey;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.data = JSON.parse(raw) as KeyVaultFile;
    } catch {
      this.data = { version: 1, keys: [] };
    }
    if (this.data.keys.length > 0) {
      try {
        await this.ensureMasterKey();
      } catch {
        // master key unavailable; keys remain encrypted until revealed
      }
      if (this.dedupeStoredKeys()) {
        try {
          await this.save();
        } catch {
          // ignore save failures on read-only environments
        }
      }
    }
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  list(provider?: string): StoredApiKey[] {
    return this.data.keys
      .filter((k) => (provider ? k.provider === provider : true))
      .sort((a, b) => a.priority - b.priority);
  }

  get(id: string): StoredApiKey | undefined {
    return this.data.keys.find((k) => k.id === id);
  }

  async add(input: {
    provider: string;
    name: string;
    secret: string;
    priority?: number;
  }): Promise<StoredApiKey> {
    await this.ensureLoaded();
    const masked = maskSecret(input.secret);
    const existing = this.data.keys.find(
      (key) =>
        key.provider === input.provider &&
        key.name === input.name &&
        key.masked === masked,
    );
    if (existing) {
      return existing;
    }
    const masterKey = await this.ensureMasterKey();
    const entry: StoredApiKey = {
      id: createId(),
      provider: input.provider,
      name: input.name,
      masked: maskSecret(input.secret),
      ciphertext: encryptSecret(masterKey, input.secret),
      enabled: true,
      priority: input.priority ?? this.data.keys.length + 1,
      health: "unknown",
      failureCount: 0,
    };
    this.data.keys.push(entry);
    await this.save();
    return entry;
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const before = this.data.keys.length;
    this.data.keys = this.data.keys.filter((k) => k.id !== id);
    if (this.data.keys.length < before) {
      await this.save();
    }
    return this.data.keys.length < before;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.ensureLoaded();
    const key = this.get(id);
    if (!key) {
      throw new Error(`Key not found: ${id}`);
    }
    key.enabled = enabled;
    await this.save();
  }

  async reveal(id: string): Promise<ApiKeyRef> {
    await this.ensureLoaded();
    const key = this.get(id);
    if (!key) {
      throw new Error(`Key not found: ${id}`);
    }
    const masterKey = await this.ensureMasterKey();
    return {
      id: key.id,
      provider: key.provider,
      name: key.name,
      secret: decryptSecret(masterKey, key.ciphertext),
    };
  }

  /**
   * Real network validation via provider.validateKey.
   */
  async checkKey(
    id: string,
    provider: AIProvider,
  ): Promise<{ status: KeyStatus; key: StoredApiKey }> {
    await this.ensureLoaded();
    const stored = this.get(id);
    if (!stored) {
      throw new Error(`Key not found: ${id}`);
    }
    const ref = await this.reveal(id);
    const status = await provider.validateKey(ref);
    const now = new Date().toISOString();
    stored.lastCheckMessage = status.message;
    if (status.valid && status.authenticated) {
      stored.health = "healthy";
      stored.lastSuccessAt = now;
      stored.failureCount = 0;
      stored.cooldownUntil = undefined;
    } else {
      stored.health = status.category === "RATE_LIMIT" ? "cooldown" : "failed";
      stored.lastFailureAt = now;
      stored.failureCount += 1;
      if (status.category === "RATE_LIMIT") {
        const until = new Date(Date.now() + 30_000).toISOString();
        stored.cooldownUntil = until;
      }
    }
    await this.save();
    return { status, key: stored };
  }

  async checkAll(
    resolveProvider: (providerId: string) => AIProvider | undefined,
  ): Promise<Array<{ key: StoredApiKey; status: KeyStatus }>> {
    const results = [];
    for (const key of this.list().filter((k) => k.enabled)) {
      const provider = resolveProvider(key.provider);
      if (!provider) {
        results.push({
          key,
          status: {
            valid: false,
            reachable: false,
            authenticated: false,
            modelsAvailable: false,
            message: `Unknown provider: ${key.provider}`,
            category: "UNKNOWN" as const,
          },
        });
        continue;
      }
      results.push(await this.checkKey(key.id, provider));
    }
    return results;
  }

  /**
   * Intelligent selection — healthiest compatible key (not round-robin).
   */
  selectKey(providerId: string): StoredApiKey | undefined {
    const now = Date.now();
    const candidates = this.list(providerId).filter((k) => {
      if (!k.enabled) {
        return false;
      }
      if (k.cooldownUntil && Date.parse(k.cooldownUntil) > now) {
        return false;
      }
      if (k.health === "failed" && k.failureCount >= 5) {
        return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      return undefined;
    }

    const scored = candidates
      .map((key) => ({
        key,
        score: scoreKey(key),
      }))
      .sort((a, b) => b.score - a.score || a.key.priority - b.key.priority);

    return scored[0]?.key;
  }

  async markRateLimited(id: string, retryAfterSec = 30): Promise<void> {
    await this.ensureLoaded();
    const key = this.get(id);
    if (!key) {
      return;
    }
    key.health = "cooldown";
    key.failureCount += 1;
    key.lastFailureAt = new Date().toISOString();
    key.cooldownUntil = new Date(
      Date.now() + retryAfterSec * 1000,
    ).toISOString();
    await this.save();
  }

  async markSuccess(id: string): Promise<void> {
    await this.ensureLoaded();
    const key = this.get(id);
    if (!key) {
      return;
    }
    key.health = "healthy";
    key.failureCount = 0;
    key.lastSuccessAt = new Date().toISOString();
    key.cooldownUntil = undefined;
    await this.save();
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.masterKey) {
      await this.load();
    }
  }

  /** Drop exact duplicate vault rows (same provider, label, masked secret). */
  private dedupeStoredKeys(): boolean {
    const seen = new Set<string>();
    const kept: StoredApiKey[] = [];
    for (const key of [...this.data.keys].sort(
      (a, b) => a.priority - b.priority,
    )) {
      const fingerprint = `${key.provider}\0${key.name}\0${key.masked}`;
      if (seen.has(fingerprint)) {
        continue;
      }
      seen.add(fingerprint);
      kept.push(key);
    }
    if (kept.length === this.data.keys.length) {
      return false;
    }
    this.data.keys = kept.map((key, index) => ({
      ...key,
      priority: index + 1,
    }));
    return true;
  }
}

function scoreKey(key: StoredApiKey): number {
  let score = 100 - key.priority;
  if (key.health === "healthy") {
    score += 50;
  }
  if (key.health === "degraded") {
    score += 10;
  }
  if (key.health === "unknown") {
    score += 20;
  }
  score -= key.failureCount * 5;
  return score;
}
