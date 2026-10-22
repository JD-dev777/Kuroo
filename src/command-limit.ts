import { SlidingWindow } from './security-policy.js';
const cooldown = new SlidingWindow();
const inFlight = new Set<string>();
const cleanup = setInterval(() => cooldown.prune(Date.now(), 10_000), 30_000);
cleanup.unref();
// Slash, prefix and component actions share this budget.
export function acquireCommand(key: string): (() => void) | null {
  if (cooldown.hit(key, Date.now(), 10_000) > 5 || inFlight.has(key)) return null;
  inFlight.add(key);
  return () => { inFlight.delete(key); };
}
