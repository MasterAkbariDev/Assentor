/**
 * Detects repeated reviewer change requests across rounds.
 * Pure fingerprinting — no I/O.
 */

export interface LoopSignal {
  fingerprint: string;
  count: number;
  rounds: number[];
}

export interface LoopDetectorOptions {
  /** How many identical fingerprints trigger a loop warning. Default: 3 */
  threshold?: number;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Builds a stable fingerprint for a set of required changes / issue ids.
 */
export function fingerprintChangeRequest(input: {
  requiredChanges?: string[];
  issueIds?: string[];
  summary?: string;
}): string {
  const issues = (input.issueIds ?? []).map(normalizeText).filter(Boolean).sort();
  const changes = (input.requiredChanges ?? [])
    .map(normalizeText)
    .filter(Boolean)
    .sort();

  if (issues.length > 0 || changes.length > 0) {
    return `issues:${issues.join("|")}::changes:${changes.join("|")}`;
  }

  const summary = input.summary ? normalizeText(input.summary) : "";
  return summary ? `summary:${summary}` : "empty";
}

export class LoopDetector {
  private readonly threshold: number;
  private readonly history: Array<{ round: number; fingerprint: string }> = [];

  constructor(options: LoopDetectorOptions = {}) {
    this.threshold = options.threshold ?? 3;
  }

  record(round: number, fingerprint: string): LoopSignal {
    this.history.push({ round, fingerprint });

    const matches = this.history.filter((entry) => entry.fingerprint === fingerprint);
    return {
      fingerprint,
      count: matches.length,
      rounds: matches.map((entry) => entry.round),
    };
  }

  isLoop(signal: LoopSignal): boolean {
    return signal.count >= this.threshold && signal.fingerprint !== "empty";
  }

  /**
   * Records and returns whether the supervisor should challenge the reviewer.
   */
  check(
    round: number,
    input: {
      requiredChanges?: string[];
      issueIds?: string[];
      summary?: string;
    },
  ): { signal: LoopSignal; looping: boolean } {
    const fingerprint = fingerprintChangeRequest(input);
    const signal = this.record(round, fingerprint);
    return { signal, looping: this.isLoop(signal) };
  }

  reset(): void {
    this.history.length = 0;
  }

  getHistory(): readonly { round: number; fingerprint: string }[] {
    return this.history;
  }
}
