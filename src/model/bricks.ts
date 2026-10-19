// Grid units: x and z are in studs, y is in plate heights (1 brick = 3 plates).
// Real-world scale: 1 stud = 8 mm, 1 plate = 3.2 mm.

export type BrickType = '2x2' | '2x4';
export type Rotation = 0 | 90 | 180 | 270;

export interface BrickDef {
  width: number; // studs along x at rotation 0
  depth: number; // studs along z at rotation 0
  height: number; // plates
}

export const BRICK_DEFS: Record<BrickType, BrickDef> = {
  '2x2': { width: 2, depth: 2, height: 3 },
  '2x4': { width: 2, depth: 4, height: 3 },
};

export const PALETTE = ['#c91a09', '#0055bf', '#f2cd37', '#237841', '#ffffff', '#05131d'] as const;

/** Where and how a brick sits. (x, z) is the min corner of its footprint after rotation. */
export interface Placement {
  type: BrickType;
  x: number;
  y: number;
  z: number;
  rot: Rotation;
}

export interface Brick extends Placement {
  id: string;
  color: string;
}

export function footprintSize(type: BrickType, rot: Rotation): { w: number; d: number } {
  const { width, depth } = BRICK_DEFS[type];
  return rot === 90 || rot === 270 ? { w: depth, d: width } : { w: width, d: depth };
}

/** Every (x, z) stud cell the brick covers. */
export function footprintCells(p: Placement): Array<[number, number]> {
  const { w, d } = footprintSize(p.type, p.rot);
  const cells: Array<[number, number]> = [];
  for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) cells.push([p.x + i, p.z + j]);
  return cells;
}

export function nextRotation(rot: Rotation): Rotation {
  return ((rot + 90) % 360) as Rotation;
}

export function isRotation(v: unknown): v is Rotation {
  return v === 0 || v === 90 || v === 180 || v === 270;
}

export function isBrickType(v: unknown): v is BrickType {
  return typeof v === 'string' && v in BRICK_DEFS;
}

export function isColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
}
