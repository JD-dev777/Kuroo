export class SlidingWindow {
  private entries = new Map<string, number[]>();
  hit(key: string, now: number, windowMs: number): number {
    const recent = (this.entries.get(key) ?? []).filter(time => time > now - windowMs);
    recent.push(now);
    this.entries.set(key, recent);
    return recent.length;
  }
  prune(now: number, maxWindowMs: number) {
    for (const [key, timestamps] of this.entries) {
      const recent = timestamps.filter(time => time > now - maxWindowMs);
      if (recent.length) this.entries.set(key, recent); else this.entries.delete(key);
    }
  }
}
export function canModerate(actor: { id: string; position: number }, target: { id: string; position: number }, ownerId: string, botId: string) {
  return target.id !== ownerId && target.id !== botId && target.id !== actor.id && (actor.id === ownerId || actor.position > target.position);
}
