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
    renderer: { domElement: canvas }, brickAt: () => added.brick.id,
    pick: () => ({ gx: 9, gz: 9 }),
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
