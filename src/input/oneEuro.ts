/**
 * One Euro filter (Casiez et al. 2012): heavy smoothing when still, little lag when moving fast.
 * minCutoff lowers jitter at rest; beta reduces lag during fast motion.
 */
export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private lastT = 0;

  constructor(
    public minCutoff = 1.5,
    public beta = 4,
    public dCutoff = 1,
  ) {}

  filter(value: number, tSeconds: number): number {
    if (this.x === null) {
      this.x = value;
      this.lastT = tSeconds;
      return value;
    }
    const dt = Math.max(tSeconds - this.lastT, 1e-3);
    this.lastT = tSeconds;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  reset() {
    this.x = null;
    this.dx = 0;
  }
}

function alpha(cutoff: number, dt: number) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
