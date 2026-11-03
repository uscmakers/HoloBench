import type { Point3 } from './handMath';

export type Gesture = 'none' | 'open' | 'pinch' | 'middle' | 'fist' | 'palm';

export interface GestureMetrics {
  /** Thumb tip to index tip, divided by palm length. */
  index: number;
  /** Thumb tip to middle tip, divided by palm length. */
  middle: number;
  /** Average fingertip-to-wrist distance, divided by palm length. Small = fingers curled. */
  curl: number;
  /** Index tip to pinky tip, divided by palm length. Large = fingers fanned out. */
  spread: number;
  /** How many of the four fingers are straight (tip clearly farther from the wrist than the middle joint). */
  extended: number;
}

const dist = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const EXTENDED_RATIO = 1.15;

/** Size-independent measurements from MediaPipe world landmarks (meters). */
export function measure(world: Point3[]): GestureMetrics {
  const palm = Math.max(dist(world[0], world[9]), 1e-6);
  const curl = [8, 12, 16, 20].reduce((s, i) => s + dist(world[i], world[0]), 0) / 4 / palm;
  return {
    index: dist(world[4], world[8]) / palm,
    middle: dist(world[4], world[12]) / palm,
    curl,
    spread: dist(world[8], world[20]) / palm,
    // Tip vs middle joint (PIP) of each finger: works at any hand angle, unlike a fixed length.
    extended: [
      [8, 6],
      [12, 10],
      [16, 14],
      [20, 18],
    ].filter(([tip, pip]) => dist(world[tip], world[0]) > dist(world[pip], world[0]) * EXTENDED_RATIO).length,
  };
}

export interface GestureThresholds {
  pinchClose: number;
  pinchOpen: number;
  fistBelow: number;
  fistAbove: number;
  /** Open palm (menu): at least `palmFingers` fingers straight and fanned out wider than `palmSpread`. */
  palmSpread: number;
  palmSpreadRelease: number;
  palmFingers: number;
  /** Sanity floor on how open the hand is overall. */
  palmCurl: number;
}

export const DEFAULT_THRESHOLDS: GestureThresholds = {
  pinchClose: 0.3,
  pinchOpen: 0.45,
  fistBelow: 1.15,
  fistAbove: 1.35,
  palmSpread: 0.95,
  palmSpreadRelease: 0.8,
  palmFingers: 4,
  palmCurl: 1.45,
};

/**
 * Raw gesture for one frame. `current` gives hysteresis: a gesture already held
 * uses the looser "release" threshold, so noise near a threshold doesn't flicker.
 */
export function classify(m: GestureMetrics, current: Gesture, t: GestureThresholds = DEFAULT_THRESHOLDS): Gesture {
  const fist = m.curl < (current === 'fist' ? t.fistAbove : t.fistBelow);
  if (fist) return 'fist';
  const indexPinch = m.index < (current === 'pinch' ? t.pinchOpen : t.pinchClose);
  if (indexPinch) return 'pinch';
  // Middle pinch only counts when the index finger is clearly apart, so a sloppy full pinch isn't misread.
  const middlePinch = m.middle < (current === 'middle' ? t.pinchOpen : t.pinchClose) && m.index > t.pinchOpen;
  if (middlePinch) return 'middle';
  const palm =
    m.extended >= (current === 'palm' ? t.palmFingers - 1 : t.palmFingers) &&
    m.curl > t.palmCurl &&
    m.spread > (current === 'palm' ? t.palmSpreadRelease : t.palmSpread);
  if (palm) return 'palm';
  return 'open';
}

/** Frames a new gesture must persist before it counts (fist is slower so passing through it while moving doesn't trigger). */
const CONFIRM: Record<Gesture, number> = { none: 1, open: 2, pinch: 2, middle: 3, fist: 8, palm: 4 };

/** Debounced gesture state for one hand. */
export class GestureDetector {
  gesture: Gesture = 'none';
  metrics: GestureMetrics | null = null;
  private candidate: Gesture = 'none';
  private count = 0;

  constructor(public thresholds: GestureThresholds = { ...DEFAULT_THRESHOLDS }) {}

  /** Pass null when the hand is not visible. Returns the gesture that just began, if any. */
  update(world: Point3[] | null): Gesture | null {
    if (!world) {
      this.metrics = null;
      this.candidate = 'none';
      this.count = 0;
      if (this.gesture === 'none') return null;
      this.gesture = 'none';
      return 'none';
    }
    this.metrics = measure(world);
    const raw = classify(this.metrics, this.gesture, this.thresholds);
    if (raw === this.gesture) {
      this.candidate = raw;
      this.count = 0;
      return null;
    }
    this.count = raw === this.candidate ? this.count + 1 : 1;
    this.candidate = raw;
    if (this.count < CONFIRM[raw]) return null;
    this.gesture = raw;
    this.count = 0;
    return raw;
  }
}
