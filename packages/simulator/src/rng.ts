/**
 * A tiny deterministic PRNG (mulberry32). Seeded fixtures and fault decisions use
 * it so a simulator run is fully reproducible — no `Math.random`, no clock.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Next integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** A short deterministic hex token. */
  token(len = 8): string {
    let out = "";
    while (out.length < len) out += this.int(16).toString(16);
    return out.slice(0, len);
  }
}
