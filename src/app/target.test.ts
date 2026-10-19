import { describe, expect, it } from 'vitest';
import { BuildModel } from '../model/build';
import { placementAt } from './target';

describe('placementAt', () => {
  it('centres the brick on the pointed-at spot and snaps to studs', () => {
    const m = new BuildModel(16, 16);
    expect(placementAt(m, 5.3, 5.6, '2x2', 0)).toMatchObject({ x: 4, z: 5, y: 0 });
    expect(placementAt(m, 8, 8, '2x4', 90)).toMatchObject({ x: 6, z: 7 });
  });
  it('keeps the brick on the baseplate near the edge', () => {
    const m = new BuildModel(16, 16);
    expect(placementAt(m, 15.9, 0.1, '2x4', 0)).toMatchObject({ x: 14, z: 0 });
  });
  it('drops onto the stack under the cursor', () => {
    const m = new BuildModel(16, 16);
    m.add({ type: '2x2', x: 4, y: 0, z: 4, rot: 0 }, '#ffffff');
    expect(placementAt(m, 5, 5, '2x2', 0).y).toBe(3);
  });
});
