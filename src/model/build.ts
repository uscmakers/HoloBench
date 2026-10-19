import {
  BRICK_DEFS,
  type Brick,
  type Placement,
  footprintCells,
  footprintSize,
  isBrickType,
  isColor,
  isRotation,
} from './bricks';

export type Reason = 'out_of_bounds' | 'collision' | 'unsupported' | 'would_disconnect' | 'not_found';
export type Check = { ok: true } | { ok: false; reason: Reason };
export type Result = { ok: true; brick: Brick } | { ok: false; reason: Reason };

type Command =
  | { kind: 'add'; brick: Brick }
  | { kind: 'remove'; brick: Brick }
  | { kind: 'move'; id: string; from: Placement; to: Placement };

export const FORMAT = 'holo-bricks';
export const FORMAT_VERSION = 1;

export interface BuildFile {
  format: typeof FORMAT;
  version: number;
  baseplate: { width: number; depth: number };
  bricks: Array<Omit<Brick, 'id'>>;
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/**
 * The whole build as plain data, independent of rendering and input.
 * Invariant: every brick is inside the baseplate, overlaps nothing, and is
 * connected (through studs, above or below) to a chain that reaches the baseplate.
 */
export class BuildModel {
  private bricks = new Map<string, Brick>();
  private cells = new Map<string, string>(); // "x,y,z" -> brick id
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private listeners = new Set<() => void>();
  private nextId = 1;

  constructor(readonly width = 32, readonly depth = 32) {}

  // ---- queries ----

  getBricks(): Brick[] {
    return [...this.bricks.values()];
  }

  getBrick(id: string): Brick | undefined {
    return this.bricks.get(id);
  }

  brickAt(x: number, y: number, z: number): Brick | undefined {
    const id = this.cells.get(key(x, y, z));
    return id ? this.bricks.get(id) : undefined;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  /** Lowest y where the brick rests on top of whatever is under its footprint. */
  dropHeight(p: Omit<Placement, 'y'>, ignoreId?: string): number {
    const cells = new Set(footprintCells({ ...p, y: 0 }).map(([x, z]) => `${x},${z}`));
    let top = 0;
    for (const b of this.bricks.values()) {
      if (b.id === ignoreId) continue;
      if (footprintCells(b).some(([x, z]) => cells.has(`${x},${z}`))) {
        top = Math.max(top, b.y + BRICK_DEFS[b.type].height);
      }
    }
    return top;
  }

  /** Can this placement go into the current build? `ignoreId` treats that brick as absent (for moves). */
  validate(p: Placement, ignoreId?: string): Check {
    const { w, d } = footprintSize(p.type, p.rot);
    const h = BRICK_DEFS[p.type].height;
    if (p.x < 0 || p.z < 0 || p.y < 0 || p.x + w > this.width || p.z + d > this.depth) {
      return { ok: false, reason: 'out_of_bounds' };
    }
    const cells = footprintCells(p);
    const other = (x: number, y: number, z: number) => {
      const id = this.cells.get(key(x, y, z));
      return id !== undefined && id !== ignoreId;
    };
    for (const [x, z] of cells) {
      for (let y = p.y; y < p.y + h; y++) if (other(x, y, z)) return { ok: false, reason: 'collision' };
    }
    const connected =
      p.y === 0 || cells.some(([x, z]) => other(x, p.y - 1, z) || other(x, p.y + h, z));
    return connected ? { ok: true } : { ok: false, reason: 'unsupported' };
  }

  /** True if taking this brick out leaves every other brick still connected to the baseplate. */
  canRemove(id: string): boolean {
    if (!this.bricks.has(id)) return false;
    return this.allGrounded(id);
  }

  // ---- edits (each is one undo step) ----

  add(p: Placement, color: string): Result {
    const check = this.validate(p);
    if (!check.ok) return check;
    const brick: Brick = { id: `b${this.nextId++}`, type: p.type, color, x: p.x, y: p.y, z: p.z, rot: p.rot };
    this.run({ kind: 'add', brick });
    return { ok: true, brick };
  }

  remove(id: string): Result {
    const brick = this.bricks.get(id);
    if (!brick) return { ok: false, reason: 'not_found' };
    if (!this.canRemove(id)) return { ok: false, reason: 'would_disconnect' };
    this.run({ kind: 'remove', brick: { ...brick } });
    return { ok: true, brick };
  }

  move(id: string, to: Placement): Result {
    const brick = this.bricks.get(id);
    if (!brick) return { ok: false, reason: 'not_found' };
    if (to.type !== brick.type) return { ok: false, reason: 'collision' };
    if (!this.canRemove(id)) return { ok: false, reason: 'would_disconnect' };
    const check = this.validate(to, id);
    if (!check.ok) return check;
    const from: Placement = { type: brick.type, x: brick.x, y: brick.y, z: brick.z, rot: brick.rot };
    this.run({ kind: 'move', id, from, to: { ...to } });
    return { ok: true, brick: this.bricks.get(id)! };
  }

  undo(): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    this.apply(invert(cmd));
    this.redoStack.push(cmd);
    this.emit();
    return true;
  }

  redo(): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    this.apply(cmd);
    this.undoStack.push(cmd);
    this.emit();
    return true;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---- save / load ----

  toJSON(): BuildFile {
    return {
      format: FORMAT,
      version: FORMAT_VERSION,
      baseplate: { width: this.width, depth: this.depth },
      bricks: this.getBricks().map(({ type, color, x, y, z, rot }) => ({ type, color, x, y, z, rot })),
    };
  }

  /** Builds a model from saved data. Throws with a readable message if the data is malformed or not a valid build. */
  static fromJSON(data: unknown): BuildModel {
    const file = data as Partial<BuildFile> | null;
    if (!file || file.format !== FORMAT) throw new Error(`Not a ${FORMAT} file`);
    if (file.version !== FORMAT_VERSION) throw new Error(`Unsupported version ${file.version}`);
    const { width, depth } = file.baseplate ?? {};
    if (!Number.isInteger(width) || !Number.isInteger(depth) || width! <= 0 || depth! <= 0) {
      throw new Error('Invalid baseplate size');
    }
    if (!Array.isArray(file.bricks)) throw new Error('Missing bricks list');

    const model = new BuildModel(width, depth);
    file.bricks.forEach((b, i) => {
      const ints = [b?.x, b?.y, b?.z].every(Number.isInteger);
      if (!b || !isBrickType(b.type) || !isColor(b.color) || !isRotation(b.rot) || !ints) {
        throw new Error(`Brick ${i}: malformed`);
      }
      // Connections are checked for the whole build below, since file order may not be build order.
      const { w, d } = footprintSize(b.type, b.rot);
      if (b.x < 0 || b.z < 0 || b.y < 0 || b.x + w > width! || b.z + d > depth!) {
        throw new Error(`Brick ${i}: out of bounds`);
      }
      const brick: Brick = { id: `b${model.nextId++}`, type: b.type, color: b.color, x: b.x, y: b.y, z: b.z, rot: b.rot };
      if (model.occupied(brick)) throw new Error(`Brick ${i}: overlaps another brick`);
      model.insert(brick);
    });
    if (!model.allGrounded()) throw new Error('Some bricks are not connected to the baseplate');
    return model;
  }

  // ---- internals ----

  private run(cmd: Command) {
    this.apply(cmd);
    this.undoStack.push(cmd);
    this.redoStack = [];
    this.emit();
  }

  private apply(cmd: Command) {
    switch (cmd.kind) {
      case 'add':
        this.insert({ ...cmd.brick });
        break;
      case 'remove':
        this.erase(cmd.brick.id);
        break;
      case 'move': {
        const brick = this.bricks.get(cmd.id)!;
        this.erase(cmd.id);
        this.insert({ ...brick, ...cmd.to });
        break;
      }
    }
  }

  private occupied(b: Placement): boolean {
    const h = BRICK_DEFS[b.type].height;
    return footprintCells(b).some(([x, z]) => {
      for (let y = b.y; y < b.y + h; y++) if (this.cells.has(key(x, y, z))) return true;
      return false;
    });
  }

  private insert(b: Brick) {
    this.bricks.set(b.id, b);
    const h = BRICK_DEFS[b.type].height;
    for (const [x, z] of footprintCells(b)) for (let y = b.y; y < b.y + h; y++) this.cells.set(key(x, y, z), b.id);
  }

  private erase(id: string) {
    const b = this.bricks.get(id);
    if (!b) return;
    const h = BRICK_DEFS[b.type].height;
    for (const [x, z] of footprintCells(b)) for (let y = b.y; y < b.y + h; y++) this.cells.delete(key(x, y, z));
    this.bricks.delete(id);
  }

  /** Bricks whose studs connect to this one (sitting on top, or hanging below). */
  private neighbors(b: Brick): Set<string> {
    const h = BRICK_DEFS[b.type].height;
    const out = new Set<string>();
    for (const [x, z] of footprintCells(b)) {
      for (const y of [b.y - 1, b.y + h]) {
        const id = this.cells.get(key(x, y, z));
        if (id && id !== b.id) out.add(id);
      }
    }
    return out;
  }

  private allGrounded(excludeId?: string): boolean {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const b of this.bricks.values()) {
      if (b.y === 0 && b.id !== excludeId) {
        seen.add(b.id);
        queue.push(b.id);
      }
    }
    while (queue.length) {
      for (const n of this.neighbors(this.bricks.get(queue.pop()!)!)) {
        if (n !== excludeId && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    return seen.size === this.bricks.size - (excludeId && this.bricks.has(excludeId) ? 1 : 0);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

function invert(cmd: Command): Command {
  switch (cmd.kind) {
    case 'add':
      return { kind: 'remove', brick: cmd.brick };
    case 'remove':
      return { kind: 'add', brick: cmd.brick };
    case 'move':
      return { kind: 'move', id: cmd.id, from: cmd.to, to: cmd.from };
  }
}
