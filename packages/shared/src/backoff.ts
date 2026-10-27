/** Exponential backoff with full jitter. `random` is injectable for tests. */
export function backoffDelay(
  attempt: number,
  {
    baseMs = 500,
    maxMs = 30_000,
    random = Math.random,
  }: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 16));
  return Math.floor(random() * cap);
}
