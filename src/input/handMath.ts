export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Image-space box (0..1, as the user sees the mirrored preview) that maps to the whole screen. */
export interface Zone {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const DEFAULT_ZONE: Zone = { x0: 0.2, y0: 0.15, x1: 0.8, y1: 0.7 };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Maps a camera-image point (0..1, unmirrored) into viewport coordinates through the zone. */
export function mapToViewport(p: { x: number; y: number }, zone: Zone = DEFAULT_ZONE, mirror = true) {
  const x = mirror ? 1 - p.x : p.x;
  return {
    x: clamp01((x - zone.x0) / (zone.x1 - zone.x0)),
    y: clamp01((p.y - zone.y0) / (zone.y1 - zone.y0)),
  };
}

/**
 * Cursor anchor: average of the wrist and the four knuckles.
 * Unlike a fingertip, it barely moves when the user pinches.
 */
export function palmCenter(lm: Point3[]): { x: number; y: number } {
  const ids = [0, 5, 9, 13, 17];
  let x = 0;
  let y = 0;
  for (const i of ids) {
    x += lm[i].x;
    y += lm[i].y;
  }
  return { x: x / ids.length, y: y / ids.length };
}

const dist = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Thumb-tip to index-tip distance divided by palm length, so it doesn't depend on hand size or distance to camera. */
export function pinchRatio(lm: Point3[]): number {
  return dist(lm[4], lm[8]) / Math.max(dist(lm[0], lm[9]), 1e-6);
}

/** Palm length in image space (wrist to middle knuckle). Grows as the hand moves toward the camera. */
export function palmSize(lm: Point3[], aspect = 4 / 3): number {
  return Math.hypot((lm[0].x - lm[9].x) * aspect, lm[0].y - lm[9].y);
}

export type Role = 'build' | 'view';

/**
 * Decides which detected hand builds and which controls the view.
 * labels: MediaPipe handedness per hand. MediaPipe assumes a mirrored image, and the webcam
 * frame is not mirrored, so its "Left" is the user's right hand.
 * xs: each hand's x in the camera image (unmirrored), used when labels are missing or identical.
 */
export function assignRoles(labels: Array<string | undefined>, xs: number[], swap = false): Role[] {
  const userRight = (i: number) => labels[i] === 'Left';
  let roles: Role[];
  if (labels.length === 2 && labels[0] && labels[1] && labels[0] !== labels[1]) {
    roles = labels.map((_, i) => (userRight(i) ? 'build' : 'view'));
  } else if (labels.length === 2) {
    // Same label on both: the hand further to the user's right (smaller unmirrored x) builds.
    roles = xs[0] < xs[1] ? ['build', 'view'] : ['view', 'build'];
  } else {
    roles = labels.map((_, i) => (userRight(i) ? 'build' : 'view'));
  }
  return swap ? roles.map((r) => (r === 'build' ? 'view' : 'build')) : roles;
}

export interface ViewDelta {
  /** Horizontal move, viewport units, positive = user's right. */
  dx: number;
  /** Vertical move, viewport units, positive = down. */
  dy: number;
  /** Palm size ratio this frame vs last; > 1 means the hand moved toward the camera. */
  zoom: number;
}

/**
 * Clutch for the view hand: motion only counts while pinched, measured relative to where the
 * pinch began, so absolute hand depth never matters.
 */
export class ViewGrab {
  private prev: { x: number; y: number; size: number } | null = null;

  get grabbing() {
    return this.prev !== null;
  }

  update(p: { x: number; y: number; size: number } | null, pinched: boolean): ViewDelta {
    if (!p || !pinched) {
      this.prev = null;
      return { dx: 0, dy: 0, zoom: 1 };
    }
    const prev = this.prev;
    this.prev = p;
    if (!prev) return { dx: 0, dy: 0, zoom: 1 };
    return { dx: p.x - prev.x, dy: p.y - prev.y, zoom: p.size / prev.size };
  }
}
