import { describe, expect, it } from 'vitest';
import { footprintCells, footprintSize, type Placement } from './bricks';
import { BuildModel } from './build';

const RED = '#c91a09';
const at = (type: Placement['type'], x: number, y: number, z: number, rot: Placement['rot'] = 0): Placement => ({
  type, x, y, z, rot,
});

describe('footprint', () => {
  it('swaps width and depth at 90 and 270 degrees', () => {
    expect(footprintSize('2x4', 0)).toEqual({ w: 2, d: 4 });
    expect(footprintSize('2x4', 90)).toEqual({ w: 4, d: 2 });
    expect(footprintSize('2x4', 270)).toEqual({ w: 4, d: 2 });
    expect(footprintCells(at('2x4', 5, 0, 5, 90))).toHaveLength(8);
  });
});

describe('placement rules', () => {
  it('places a brick on the baseplate', () => {
    const m = new BuildModel(16, 16);
    const r = m.add(at('2x2', 0, 0, 0), RED);
    expect(r.ok).toBe(true);
    expect(m.brickAt(1, 2, 1)?.type).toBe('2x2');
    expect(m.brickAt(2, 0, 0)).toBeUndefined();
  });

  it('rejects bricks outside the baseplate', () => {
    const m = new BuildModel(16, 16);
    expect(m.validate(at('2x4', 14, 0, 13))).toEqual({ ok: false, reason: 'out_of_bounds' });
    expect(m.validate(at('2x4', 13, 0, 14, 90))).toEqual({ ok: false, reason: 'out_of_bounds' });
    expect(m.validate(at('2x4', 12, 0, 12, 90)).ok).toBe(true);
    expect(m.validate(at('2x2', -1, 0, 0)).ok).toBe(false);
  });

  it('rejects overlapping bricks', () => {
    const m = new BuildModel();
    m.add(at('2x4', 0, 0, 0), RED);
    expect(m.validate(at('2x2', 1, 0, 3))).toEqual({ ok: false, reason: 'collision' });
    expect(m.validate(at('2x2', 2, 0, 0)).ok).toBe(true); // touching side by side is fine
  });

  it('rejects floating bricks and accepts stacked ones', () => {
    const m = new BuildModel();
    m.add(at('2x2', 0, 0, 0), RED);
    expect(m.validate(at('2x2', 10, 3, 10))).toEqual({ ok: false, reason: 'unsupported' });
    expect(m.validate(at('2x2', 1, 3, 1)).ok).toBe(true); // overlaps one stud of the brick below
    expect(m.validate(at('2x2', 2, 3, 0)).ok).toBe(false); // beside, not on top
  });

  it('allows a brick hanging under another brick', () => {
    const m = new BuildModel();
    m.add(at('2x2', 0, 0, 0), RED);
    m.add(at('2x2', 0, 3, 0), RED);
    m.add(at('2x4', 0, 6, 0, 90), RED); // overhangs to x = 2..3
    // Nothing below at x = 2..3, y = 3, only the overhang above it:
    expect(m.brickAt(2, 2, 0)).toBeUndefined();
    expect(m.validate(at('2x2', 2, 3, 0)).ok).toBe(true);
  });

  it('computes drop height from the tallest brick under the footprint', () => {
    const m = new BuildModel();
    expect(m.dropHeight({ type: '2x2', x: 0, z: 0, rot: 0 })).toBe(0);
    m.add(at('2x2', 0, 0, 0), RED);
    m.add(at('2x2', 0, 3, 0), RED);
    expect(m.dropHeight({ type: '2x4', x: 1, z: 0, rot: 90 })).toBe(6);
    expect(m.dropHeight({ type: '2x2', x: 2, z: 0, rot: 0 })).toBe(0);
  });
});

describe('removing and moving placed bricks', () => {
  it('only lifts bricks whose removal keeps everything connected', () => {
    const m = new BuildModel();
    const base = m.add(at('2x2', 0, 0, 0), RED);
    const top = m.add(at('2x2', 0, 3, 0), RED);
    if (!base.ok || !top.ok) throw new Error('setup failed');
    expect(m.canRemove(base.brick.id)).toBe(false);
    expect(m.remove(base.brick.id)).toEqual({ ok: false, reason: 'would_disconnect' });
    expect(m.canRemove(top.brick.id)).toBe(true);
  });

  it('allows lifting a brick whose top neighbour is held up elsewhere (a bridge)', () => {
    const m = new BuildModel();
    const left = m.add(at('2x2', 0, 0, 0), RED);
    m.add(at('2x2', 4, 0, 0), RED);
    m.add(at('2x4', 0, 3, 0, 90), RED); // x 0..3
    m.add(at('2x4', 2, 6, 0, 90), RED); // x 2..5, on the first bridge
    m.add(at('2x2', 4, 3, 0), RED); // supports the second bridge too
    if (!left.ok) throw new Error('setup failed');
    expect(m.canRemove(left.brick.id)).toBe(true);
  });

  it('moves a brick and rejects a move into an occupied spot', () => {
    const m = new BuildModel();
    const a = m.add(at('2x2', 0, 0, 0), RED);
    m.add(at('2x2', 4, 0, 4), RED);
    if (!a.ok) throw new Error('setup failed');
    expect(m.move(a.brick.id, at('2x2', 4, 0, 4))).toEqual({ ok: false, reason: 'collision' });
    expect(m.move(a.brick.id, at('2x2', 4, 3, 4, 90)).ok).toBe(true);
    expect(m.brickAt(0, 0, 0)).toBeUndefined();
    expect(m.brickAt(5, 4, 5)?.id).toBe(a.brick.id);
  });

  it('can move a brick to a spot overlapping where it was', () => {
    const m = new BuildModel();
    const a = m.add(at('2x4', 0, 0, 0), RED);
    if (!a.ok) throw new Error('setup failed');
    expect(m.move(a.brick.id, at('2x4', 0, 0, 1)).ok).toBe(true);
  });
});

describe('undo / redo', () => {
  it('undoes and redoes add, move and remove in order', () => {
    const m = new BuildModel();
    const a = m.add(at('2x2', 0, 0, 0), RED);
    if (!a.ok) throw new Error('setup failed');
    m.move(a.brick.id, at('2x2', 6, 0, 6));
    m.remove(a.brick.id);
    expect(m.getBricks()).toHaveLength(0);

    m.undo();
    expect(m.brickAt(6, 0, 6)?.id).toBe(a.brick.id);
    m.undo();
    expect(m.brickAt(0, 0, 0)?.id).toBe(a.brick.id);
    m.undo();
    expect(m.getBricks()).toHaveLength(0);
    expect(m.canUndo).toBe(false);

    m.redo();
    m.redo();
    expect(m.brickAt(6, 0, 6)?.id).toBe(a.brick.id);
  });

  it('clears redo after a new edit', () => {
    const m = new BuildModel();
    m.add(at('2x2', 0, 0, 0), RED);
    m.undo();
    m.add(at('2x2', 4, 0, 0), RED);
    expect(m.canRedo).toBe(false);
  });

  it('notifies listeners on every change', () => {
    const m = new BuildModel();
    let calls = 0;
    m.onChange(() => calls++);
    m.add(at('2x2', 0, 0, 0), RED);
    m.add(at('2x2', 20, 3, 20), RED); // rejected, no event
    m.undo();
    expect(calls).toBe(2);
  });
});

describe('save / load', () => {
  it('round-trips a build through JSON', () => {
    const m = new BuildModel(16, 24);
    m.add(at('2x2', 0, 0, 0), RED);
    m.add(at('2x4', 0, 3, 0, 90), '#0055bf');
    const json = JSON.parse(JSON.stringify(m.toJSON()));
    const loaded = BuildModel.fromJSON(json);
    expect(loaded.width).toBe(16);
    expect(loaded.depth).toBe(24);
    expect(loaded.toJSON()).toEqual(m.toJSON());
  });

  it('loads bricks listed top-first (file order is not build order)', () => {
    const m = new BuildModel();
    m.add(at('2x2', 0, 0, 0), RED);
    m.add(at('2x2', 0, 3, 0), RED);
    const file = m.toJSON();
    file.bricks.reverse();
    expect(BuildModel.fromJSON(file).getBricks()).toHaveLength(2);
  });

  it('rejects bad files with a readable message', () => {
    const good = new BuildModel().toJSON();
    expect(() => BuildModel.fromJSON({})).toThrow('Not a holo-bricks file');
    expect(() => BuildModel.fromJSON({ ...good, version: 99 })).toThrow('Unsupported version');
    const brick = { type: '2x2', color: RED, x: 0, y: 0, z: 0, rot: 0 };
    expect(() => BuildModel.fromJSON({ ...good, bricks: [{ ...brick, rot: 45 }] })).toThrow('malformed');
    expect(() => BuildModel.fromJSON({ ...good, bricks: [brick, { ...brick, x: 1 }] })).toThrow('overlaps');
    expect(() => BuildModel.fromJSON({ ...good, bricks: [{ ...brick, y: 6 }] })).toThrow('not connected');
    expect(() => BuildModel.fromJSON({ ...good, bricks: [{ ...brick, x: 31 }] })).toThrow('out of bounds');
  });
});
