import { type BrickType, type Placement, type Rotation, footprintSize } from '../model/bricks';
import type { BuildModel } from '../model/build';

/**
 * Turns a point on the build (grid units, continuous) into a snapped placement:
 * the brick is centred on the point, kept on the baseplate, and dropped onto whatever is below.
 */
export function placementAt(
  model: BuildModel,
  gx: number,
  gz: number,
  type: BrickType,
  rot: Rotation,
  ignoreId?: string,
): Placement {
  const { w, d } = footprintSize(type, rot);
  const x = Math.min(Math.max(Math.round(gx - w / 2), 0), model.width - w);
  const z = Math.min(Math.max(Math.round(gz - d / 2), 0), model.depth - d);
  const y = model.dropHeight({ type, x, z, rot }, ignoreId);
  return { type, x, y, z, rot };
}
