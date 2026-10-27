import type { NegotiationStrategy } from "../strategy.js";

/**
 * Strategy registry (T02-03a). Each strategy card adds its strategy here
 * (vote: T02-04, debate: T02-05, best-of-n: T02-06, synthesize: T02-07,
 * divide: T02-08). Ids must match `NEGOTIATE_STRATEGIES` in src/config/teams.ts.
 */
const strategies = new Map<string, NegotiationStrategy>();

export function registerStrategy(strategy: NegotiationStrategy): void {
  if (strategies.has(strategy.id)) {
    throw new Error(`negotiation strategy "${strategy.id}" is already registered`);
  }
  strategies.set(strategy.id, strategy);
}

export function getStrategy(id: string): NegotiationStrategy | undefined {
  return strategies.get(id);
}

export function listStrategies(): string[] {
  return [...strategies.keys()].sort();
}
