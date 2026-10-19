import { describe, expect, it } from 'vitest';
import { GestureDetector, classify, measure } from './gestures';
import type { Point3 } from './handMath';

/**
 * Synthetic hand in world units: wrist at origin, middle knuckle 1 unit up (palm length 1).
 * `reach` = fingertip distance from the wrist (about 1.9 open, about 1.0 curled into a fist).
 */
function hand({ index = 0.8, middle = 0.8, reach = 1.9 } = {}): Point3[] {
  const lm: Point3[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  lm[9] = { x: 0, y: 1, z: 0 };
  lm[4] = { x: 0, y: reach, z: 0 }; // thumb tip
  lm[8] = { x: index, y: reach, z: 0 };
  lm[12] = { x: middle, y: reach, z: 0 };
  lm[16] = { x: 0.6, y: reach, z: 0 };
  lm[20] = { x: 0.8, y: reach, z: 0 };
  return lm;
}

describe('classify', () => {
  it('recognises open hand, pinch, middle pinch and fist', () => {
    expect(classify(measure(hand()), 'open')).toBe('open');
    expect(classify(measure(hand({ index: 0.1 })), 'open')).toBe('pinch');
    expect(classify(measure(hand({ middle: 0.1 })), 'open')).toBe('middle');
    expect(classify(measure(hand({ reach: 0.6 })), 'open')).toBe('fist');
  });
  it('does not read a sloppy full pinch as a middle pinch', () => {
    expect(classify(measure(hand({ index: 0.35, middle: 0.1 })), 'open')).toBe('open');
  });
  it('keeps a pinch until the fingers open past the release threshold', () => {
    expect(classify(measure(hand({ index: 0.4 })), 'pinch')).toBe('pinch');
    expect(classify(measure(hand({ index: 0.4 })), 'open')).toBe('open');
  });
});

describe('GestureDetector', () => {
  it('reports a gesture once, after it is held for a few frames', () => {
    const g = new GestureDetector();
    const started = [hand(), hand(), hand({ index: 0.1 }), hand({ index: 0.1 }), hand({ index: 0.1 })].map((h) =>
      g.update(h),
    );
    expect(started).toEqual([null, 'open', null, 'pinch', null]);
  });
  it('needs a longer hold for a fist, so passing through one does not cancel', () => {
    const g = new GestureDetector();
    g.update(hand());
    g.update(hand());
    for (let i = 0; i < 4; i++) expect(g.update(hand({ reach: 0.6 }))).toBeNull();
    g.update(hand());
    expect(g.gesture).toBe('open');
    let fired = null;
    for (let i = 0; i < 8; i++) fired = g.update(hand({ reach: 0.6 })) ?? fired;
    expect(fired).toBe('fist');
  });
  it('resets when the hand leaves view', () => {
    const g = new GestureDetector();
    g.update(hand({ index: 0.1 }));
    g.update(hand({ index: 0.1 }));
    expect(g.update(null)).toBe('none');
    expect(g.gesture).toBe('none');
  });
});
