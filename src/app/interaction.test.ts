import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Interaction } from './interaction';
import { BuildModel } from '../model/build';
import type { BuildView } from '../scene/view';
import type { InputFrame } from '../input/types';

const sample = (x: number | null, gesture = 'open', pressCount = 0): InputFrame => ({
  cursor: x === null ? null : { x, y: 0.5 }, gesture, pressed: gesture === 'grasp',
  pressCount, releaseCount: gesture === 'grasp' ? 0 : pressCount, lastActive: 1,
});

function setup() {
  const model = new BuildModel();
  const added = model.add({ type: '2x2', x: 0, y: 0, z: 0, rot: 0 }, '#c91a09');
  if (!added.ok) throw new Error('setup failed');
  const chip = {
    dataset: { action: 'color', value: '#0055bf' },
    style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    classList: { add: vi.fn(), remove: vi.fn() },
    closest: () => chip,
  };
  const canvas = { closest: () => null };
  vi.stubGlobal('document', {
    elementFromPoint: (x: number) => x > 500 ? chip : canvas,
    querySelectorAll: () => [],
  });
  const view = {
    renderer: { domElement: canvas }, brickAt: (_cursor: { x: number; y: number }) => added.brick.id,
    pick: (_cursor: { x: number; y: number }) => ({ gx: 9, gz: 9 }),
    setHidden: vi.fn(), setGhost: vi.fn(), setGhostStack: vi.fn(),
  };
  return { model, id: added.brick.id, view, interaction: new Interaction(model, view as unknown as BuildView) };
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1000);
  vi.stubGlobal('innerHeight', 1000);
});
afterEach(() => vi.unstubAllGlobals());

describe('two-hand recoloring', () => {
  it.each([0, 1])('allows hand %i to hold while the other points, then releases without moving', (owner) => {
    const { model, id, interaction, view } = setup();
    const frames: [InputFrame, InputFrame] = [sample(null), sample(null)];
    frames[owner] = sample(0.2, 'grasp', 1);
    interaction.updateHands(frames, 10);
    frames[1 - owner] = sample(0.8, 'point');
    interaction.updateHands(frames, 20);
    interaction.updateHands(frames, 30);
    expect(model.getBrick(id)).toMatchObject({ color: '#0055bf', x: 0, z: 0 });
    expect(view.setHidden).toHaveBeenLastCalledWith(null);
    frames[owner] = sample(0.4, 'open', 1);
    interaction.updateHands(frames, 40);
    expect(interaction.hasHandGrab).toBe(false);
    expect(model.getBrick(id)).toMatchObject({ color: '#0055bf', x: 0, z: 0 });
    model.undo();
    expect(model.getBrick(id)?.color).toBe('#c91a09');
    model.undo();
    expect(model.getBricks()).toHaveLength(0);
  });

  it('requires pointing from the other hand', () => {
    const { model, id, interaction } = setup();
    interaction.updateHands([sample(0.2, 'grasp', 1), sample(0.8, 'open')], 10);
    interaction.updateHands([sample(0.2, 'grasp', 1), sample(0.8, 'grasp', 1)], 20);
    expect(model.getBrick(id)?.color).toBe('#c91a09');
  });

  it('does not recolor by pointing without a grasped brick', () => {
    const { model, id, interaction } = setup();
    interaction.updateHands([sample(0.2, 'point'), sample(0.8, 'point')], 10);
    expect(model.getBrick(id)?.color).toBe('#c91a09');
  });

  it('preserves stack moving when no color is chosen', () => {
    const { model, id, interaction } = setup();
    interaction.updateHands([sample(0.2, 'grasp', 1), sample(null)], 10);
    interaction.updateHands([sample(0.3, 'open', 1), sample(0.8, 'point')], 20);
    expect(model.getBrick(id)).toMatchObject({ color: '#c91a09', x: 8, z: 8 });
  });

  it('cancels a grab safely when the holding hand is lost', () => {
    const { model, id, interaction, view } = setup();
    interaction.updateHands([sample(0.2, 'grasp', 1), sample(null)], 10);
    interaction.updateHands([sample(null, 'none', 1), sample(0.8, 'point')], 20);
    expect(model.getBrick(id)).toMatchObject({ color: '#c91a09', x: 0, z: 0 });
    expect(interaction.hasHandGrab).toBe(false);
    expect(view.setHidden).toHaveBeenLastCalledWith(null);
  });
});

function setupPair() {
  const state = setup();
  const second = state.model.add({ type: '2x2', x: 4, y: 0, z: 0, rot: 0 }, '#237841');
  if (!second.ok) throw new Error('setup failed');
  vi.spyOn(state.view, 'brickAt').mockImplementation((cursor: { x: number }) =>
    cursor.x < 0.25 ? state.id : second.brick.id);
  vi.spyOn(state.view, 'pick').mockImplementation((cursor: { x: number }) => ({ gx: cursor.x * 40 + 1, gz: 9 }));
  return { ...state, ids: [state.id, second.brick.id] };
}

describe('independent hand grabs', () => {
  it.each([0, 1])('moves different blocks together and releases hand %i without dropping the other', (firstRelease) => {
    const { model, view, interaction, ids } = setupPair();
    const original = model.getBricks().map((b) => ({ ...b }));
    const frames: [InputFrame, InputFrame] = [sample(0.1, 'grasp', 1), sample(0.3, 'grasp', 1)];
    interaction.updateHands(frames, 10);
    expect(interaction.isHandGrabbing(0)).toBe(true);
    expect(interaction.isHandGrabbing(1)).toBe(true);
    expect(view.setHidden).toHaveBeenLastCalledWith(ids);
    frames[0] = sample(0.2, 'grasp', 1);
    frames[1] = sample(0.4, 'grasp', 1);
    interaction.updateHands(frames, 20);
    expect(view.setGhostStack.mock.lastCall?.[0]).toEqual([
      expect.objectContaining({ id: ids[0], placement: expect.objectContaining({ x: 8, z: 8 }), valid: true }),
      expect.objectContaining({ id: ids[1], placement: expect.objectContaining({ x: 16, z: 8 }), valid: true }),
    ]);
    frames[firstRelease] = sample(firstRelease === 0 ? 0.2 : 0.4, 'open', 1);
    interaction.updateHands(frames, 30);
    expect(interaction.isHandGrabbing(firstRelease)).toBe(false);
    expect(interaction.isHandGrabbing(1 - firstRelease)).toBe(true);
    expect(view.setHidden).toHaveBeenLastCalledWith([ids[1 - firstRelease]]);
    expect(view.setGhostStack.mock.lastCall?.[0]).toHaveLength(1);
    frames[1 - firstRelease] = sample(firstRelease === 0 ? 0.4 : 0.2, 'open', 1);
    interaction.updateHands(frames, 40);
    expect(model.getBrick(ids[0])).toMatchObject({ x: 8, z: 8 });
    expect(model.getBrick(ids[1])).toMatchObject({ x: 16, z: 8 });
    expect(interaction.hasHandGrab).toBe(false);
    expect(view.setHidden).toHaveBeenLastCalledWith(null);
    model.undo();
    model.undo();
    expect(model.getBricks().sort((a, b) => a.id.localeCompare(b.id))).toEqual(original);
  });

  it('reserves a block for only one hand even when both grasp it in the same frame', () => {
    const { interaction, view } = setup();
    interaction.updateHands([sample(0.2, 'grasp', 1), sample(0.3, 'grasp', 1)], 10);
    expect(interaction.isHandGrabbing(0)).toBe(true);
    expect(interaction.isHandGrabbing(1)).toBe(false);
    expect(view.setGhostStack.mock.lastCall?.[0]).toHaveLength(1);
    interaction.updateHands([sample(0.2, 'open', 1), sample(0.3, 'grasp', 1)], 20);
    expect(interaction.hasHandGrab).toBe(false);
    interaction.updateHands([sample(0.2, 'open', 1), sample(0.3, 'open', 1)], 30);
    interaction.updateHands([sample(0.2, 'open', 1), sample(0.3, 'grasp', 2)], 40);
    expect(interaction.isHandGrabbing(1)).toBe(true);
  });

  it.each([false, true])('rejects stacks sharing any carried block (upper block first: %s)', (upperFirst) => {
    const { model, id, interaction, view } = setup();
    const upper = model.add({ type: '2x2', x: 0, y: 3, z: 0, rot: 0 }, '#237841');
    if (!upper.ok) throw new Error('setup failed');
    vi.spyOn(view, 'brickAt').mockImplementation((cursor: { x: number }) => {
      const first = cursor.x < 0.25;
      return first !== upperFirst ? id : upper.brick.id;
    });
    interaction.updateHands([sample(0.2, 'grasp', 1), sample(0.3, 'grasp', 1)], 10);
    expect(interaction.isHandGrabbing(0)).toBe(true);
    expect(interaction.isHandGrabbing(1)).toBe(false);
    expect(view.setHidden.mock.lastCall?.[0]).toEqual(upperFirst ? [upper.brick.id] : [id, upper.brick.id]);
  });

  it.each(['none', 'fist'])('cancels only the affected hand on %s', (gesture) => {
    const { interaction, view, model, ids } = setupPair();
    interaction.updateHands([sample(0.1, 'grasp', 1), sample(0.3, 'grasp', 1)], 10);
    interaction.updateHands([sample(gesture === 'none' ? null : 0.2, gesture, 1), sample(0.4, 'grasp', 1)], 20);
    expect(interaction.isHandGrabbing(0)).toBe(false);
    expect(interaction.isHandGrabbing(1)).toBe(true);
    expect(model.getBrick(ids[0])).toMatchObject({ x: 0, z: 0 });
    expect(view.setHidden).toHaveBeenLastCalledWith([ids[1]]);
    expect(view.setGhostStack.mock.lastCall?.[0]).toHaveLength(1);
  });

  it('keeps preview validity separate and prevents dropping onto the other carried block', () => {
    const { interaction, view, model, ids } = setupPair();
    interaction.updateHands([sample(0.1, 'grasp', 1), sample(0.3, 'grasp', 1)], 10);
    vi.mocked(view.pick).mockImplementation((cursor: { x: number }) =>
      cursor.x < 0.25 ? { gx: 5, gz: 1 } : { gx: 17, gz: 9 });
    interaction.updateHands([sample(0.2, 'grasp', 1), sample(0.4, 'grasp', 1)], 20);
    expect(view.setGhostStack.mock.lastCall?.[0]).toEqual([
      expect.objectContaining({ id: ids[0], valid: false }),
      expect.objectContaining({ id: ids[1], valid: true }),
    ]);
    interaction.updateHands([sample(0.2, 'open', 1), sample(0.4, 'grasp', 1)], 30);
    expect(model.getBrick(ids[0])).toMatchObject({ x: 0, z: 0 });
    expect(interaction.isHandGrabbing(1)).toBe(true);
  });

  it('releases both blocks into a valid build when their destinations coincide', () => {
    const { interaction, view, model, ids } = setupPair();
    interaction.updateHands([sample(0.1, 'grasp', 1), sample(0.3, 'grasp', 1)], 10);
    vi.mocked(view.pick).mockReturnValue({ gx: 9, gz: 9 });
    interaction.updateHands([sample(0.2, 'open', 1), sample(0.4, 'open', 1)], 20);
    expect(model.getBrick(ids[0])).toMatchObject({ x: 8, y: 0, z: 8 });
    expect(model.getBrick(ids[1])).toMatchObject({ x: 8, y: 3, z: 8 });
    expect(BuildModel.fromJSON(model.toJSON()).toJSON()).toEqual(model.toJSON());
  });
});
