import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from './oneEuro';
import { type Point3, ViewGrab, assignRoles, mapToViewport, palmCenter, pinchRatio } from './handMath';

const zone = { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 };

describe('mapToViewport', () => {
  it('mirrors x so moving your hand right moves the cursor right', () => {
    // Hand on the camera's left side = user's right side.
    expect(mapToViewport({ x: 0.2, y: 0.5 }, zone).x).toBeCloseTo(1);
    expect(mapToViewport({ x: 0.8, y: 0.5 }, zone).x).toBeCloseTo(0);
  });
  it('maps the zone to the full screen and clamps outside it', () => {
    const mid = mapToViewport({ x: 0.5, y: 0.5 }, zone);
    expect(mid.x).toBeCloseTo(0.5);
    expect(mid.y).toBeCloseTo(0.5);
    expect(mapToViewport({ x: 0.0, y: 0.95 }, zone)).toEqual({ x: 1, y: 1 });
  });
});

/** A flat hand: wrist at origin, middle knuckle 1 unit up, with thumb and index tips a given distance apart. */
function hand(tipGap: number): Point3[] {
  const lm: Point3[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  lm[9] = { x: 0, y: 1, z: 0 };
  lm[4] = { x: -tipGap / 2, y: 1.5, z: 0 };
  lm[8] = { x: tipGap / 2, y: 1.5, z: 0 };
  return lm;
}

describe('pinchRatio', () => {
  it('is fingertip gap relative to palm size, so it ignores distance to the camera', () => {
    expect(pinchRatio(hand(0.2))).toBeCloseTo(0.2);
    const far = hand(0.2).map((p) => ({ x: p.x * 0.5, y: p.y * 0.5, z: p.z * 0.5 }));
    expect(pinchRatio(far)).toBeCloseTo(0.2);
  });
});

describe('palmCenter', () => {
  it('does not move when only the fingertips move', () => {
    expect(palmCenter(hand(0.1))).toEqual(palmCenter(hand(0.9)));
  });
});

describe('OneEuroFilter', () => {
  it('reduces jitter on a still hand', () => {
    const f = new OneEuroFilter();
    let maxDev = 0;
    for (let i = 0; i < 120; i++) {
      const noisy = 0.5 + (i % 2 ? 0.01 : -0.01);
      const out = f.filter(noisy, i / 30);
      if (i > 30) maxDev = Math.max(maxDev, Math.abs(out - 0.5));
    }
    expect(maxDev).toBeLessThan(0.005);
  });
  it('catches up with a fast move within a few frames', () => {
    const f = new OneEuroFilter();
    for (let i = 0; i < 30; i++) f.filter(0, i / 30);
    let out = 0;
    for (let i = 30; i < 36; i++) out = f.filter(0.5, i / 30);
    expect(out).toBeGreaterThan(0.4);
  });
});

describe('assignRoles', () => {
  // MediaPipe labels assume a mirrored image, so its "Left" is the user's right hand.
  it('gives the user\'s right hand the build role', () => {
    expect(assignRoles(['Left', 'Right'], [0.3, 0.7])).toEqual(['build', 'view']);
    expect(assignRoles(['Right', 'Left'], [0.7, 0.3])).toEqual(['view', 'build']);
  });
  it('handles a single hand', () => {
    expect(assignRoles(['Left'], [0.5])).toEqual(['build']);
    expect(assignRoles(['Right'], [0.5])).toEqual(['view']);
  });
  it('falls back to position when both hands get the same label', () => {
    expect(assignRoles(['Left', 'Left'], [0.7, 0.3])).toEqual(['view', 'build']);
  });
  it('swaps roles for left-handed use', () => {
    expect(assignRoles(['Left', 'Right'], [0.3, 0.7], true)).toEqual(['view', 'build']);
  });
});

describe('ViewGrab', () => {
  it('only reports motion while pinched, starting from where the pinch began', () => {
    const g = new ViewGrab();
    expect(g.update({ x: 0.2, y: 0.2, size: 1 }, false)).toEqual({ dx: 0, dy: 0, zoom: 1 });
    expect(g.update({ x: 0.5, y: 0.5, size: 1 }, true)).toEqual({ dx: 0, dy: 0, zoom: 1 });
    const d = g.update({ x: 0.6, y: 0.45, size: 1.1 }, true);
    expect(d.dx).toBeCloseTo(0.1);
    expect(d.dy).toBeCloseTo(-0.05);
    expect(d.zoom).toBeCloseTo(1.1);
    expect(g.update({ x: 0.9, y: 0.9, size: 1 }, false).dx).toBe(0);
  });
});
