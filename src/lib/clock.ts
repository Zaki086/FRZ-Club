// Injectable clock (plan §1.1 rule 5). Services never call `new Date()` directly for business time.
// - Tests and the seed pin the clock with `clock.set(date)` and move it with `clock.advance(ms)`.
// - The dev-only time-travel tool (E-25) applies an offset that is persisted in settings and synced per request.
// State lives on globalThis so every module instance (Next.js dev bundles, worker, scripts) shares it.

type ClockState = { fixedMs: number | null; offsetMs: number };

const g = globalThis as unknown as { __ccClock?: ClockState };
const state: ClockState = (g.__ccClock ??= { fixedMs: null, offsetMs: 0 });

export const clock = {
  now(): Date {
    return new Date((state.fixedMs ?? Date.now()) + state.offsetMs);
  },
  /** Pin the clock to an instant (tests, seed). Pass null to return to real time. */
  set(date: Date | null): void {
    state.fixedMs = date ? date.getTime() : null;
  },
  /** Move a pinned clock forward (or backward) by ms. No-op on a real clock other than through offset. */
  advance(ms: number): void {
    if (state.fixedMs !== null) state.fixedMs += ms;
    else state.offsetMs += ms;
  },
  isFixed(): boolean {
    return state.fixedMs !== null;
  },
  setOffset(ms: number): void {
    state.offsetMs = ms;
  },
  getOffset(): number {
    return state.offsetMs;
  },
};
