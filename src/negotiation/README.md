# Negotiation (`src/negotiation/`)

How a team of seats reaches one answer. Design: [docs/plans/app-and-multi-model.md §4.2](../../docs/plans/app-and-multi-model.md); cards T02-03…T02-08.

| File | What |
|---|---|
| `strategy.ts` | **The contract** (T02-03a): `NegotiationStrategy`, `NegotiationContext`, step reply schemas, `anonymizeProposals`, `NegotiationResultSchema`, `NegotiationCancelledError`. |
| `strategies/index.ts` | Registry: `registerStrategy`, `getStrategy`, `listStrategies`. |
| `testing/mock-context.ts` | `createMockNegotiationContext({ seats, script })` — scripted seats for strategy tests. |
| `engine.ts` | *(T02-03, later)* the real context on top of the seat scheduler, persistence and events. |

## Writing a strategy

```ts
import { anonymizeProposals, type NegotiationStrategy } from "../strategy.js";

export const firstProposal: NegotiationStrategy = {
  id: "first-proposal",
  validate: (seats) => (seats.length === 0 ? "needs at least one seat" : undefined),
  async run(ctx) {
    const replies = await Promise.all(
      ctx.seats.map((seat) => ctx.askSeat(seat.id, "negotiate-propose", { goal: ctx.goal }, { readOnly: true })),
    );
    const proposals = replies.flatMap((r) => (r.ok ? [{ seatId: r.seatId, text: r.data.proposal }] : []));
    const { anonymized } = anonymizeProposals(proposals);
    anonymized.forEach((p) => ctx.emit({ type: "negotiation.proposal", data: { round: 1, label: p.label, text: p.text } }));
    const first = anonymized[0];
    return {
      strategy: "first-proposal",
      decision: first?.text ?? "",
      rationale: first ? `took ${first.label}` : "no proposals",
      proposals: proposals.map((p, i) => ({ label: anonymized[i]!.label, seatId: p.seatId, text: p.text })),
      dissent: replies.flatMap((r) => (r.ok ? [] : [{ seatId: r.seatId, reason: r.error }])),
      rounds: 1,
      consensus: { score: first ? 1 / anonymized.length : 0, reached: Boolean(first) },
    };
  },
};
```

Test it with `createMockNegotiationContext({ seats: expandSeatSpecs([...]), script: (ask) => ({ proposal: "…" }) })` and assert on the result (validate it with `NegotiationResultSchema.parse`), `asks` (which seat got which step and vars) and `events`.

## Rules

- `NegotiationResult.proposals` carries seat ids (engine-side, for UIs and dissent). Never pass a result, or anything with seat ids, into another seat's `vars` — including from the stage runner (T02-09).
- Match model-written labels with `matchLabel`; unknown labels are dissent, not errors.
- Implementation steps (best-of-n worktrees, divide-and-conquer subtasks/integration) are added to the contract by T02-06/T02-08 under Opus review.
- `askSeat` throws for a seat id that isn't in `seats` (a programmer error) — the mock and the engine both do this.

- Other seats see proposals only through `anonymizeProposals` labels. Never put seat ids, display names or models into `vars` for another seat.
- `askSeat` never throws for a bad reply; record `ok: false` replies as `dissent`. It rejects only with `NegotiationCancelledError` — let that propagate.
- Steps that only reason use `{ readOnly: true }`.
- Deterministic: same replies → same result. No `Date`, no `Math.random`.
- Every result passes `NegotiationResultSchema`.
