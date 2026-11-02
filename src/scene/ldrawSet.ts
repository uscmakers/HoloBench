import * as THREE from 'three';
import { LDrawLoader } from 'three/examples/jsm/loaders/LDrawLoader.js';

export interface SetInfo {
  id: string;
  name: string;
  file: string;
}

/** Real LEGO sets from the LDraw Official Model Repository, packed with their parts (see public/ldraw/README.md). */
export const SETS: SetInfo[] = [
  { id: '4838-1', name: 'Mini Vehicles', file: '4838-1-MiniVehicles.mpd_Packed.mpd' },
  { id: '889-1', name: 'Radar Truck', file: '889-1-RadarTruck.mpd_Packed.mpd' },
  { id: '30023-1', name: 'Lighthouse', file: '30023-1-Lighthouse.ldr_Packed.mpd' },
];

/** 'build': the user places the set piece by piece. 'built': the finished set, steppable. */
export type SetMode = 'build' | 'built';

// LDraw units: 1 stud = 20 LDU, and +y points down.
const LDU = 1 / 20;
const HIGHLIGHT = new THREE.Color('#4fd8ff');
/** How close (world units = studs, horizontally) the held piece must be to its spot to snap in. */
const SNAP_RADIUS = 1.5;

interface Piece {
  obj: THREE.Group;
  step: number;
  /** Centre of the piece in its final position, in set (= world) coordinates. */
  center: THREE.Vector3;
}

type PieceState = 'placed' | 'target' | 'ghost' | 'hidden';

/**
 * A real LEGO set rendered from an LDraw file, with its official building steps.
 *
 * Built mode shows steps up to `step`; the parts added in `step` glow.
 * Build mode starts empty and hands the user one piece at a time, in instruction
 * order: the piece follows the cursor on a horizontal plane at its final height
 * (so no depth input is needed), its spot glows, the rest of the step shows as a
 * faint ghost, and the piece snaps in once it is close enough.
 */
export class LDrawSetView {
  readonly root = new THREE.Group();
  info: SetInfo | null = null;
  mode: SetMode = 'build';
  step = 0;
  numSteps = 0;
  /** Build mode: number of pieces placed so far. */
  placed = 0;
  pieces: Piece[] = [];

  private model: THREE.Group | null = null;
  private glowMaterials = new Map<THREE.Material, THREE.Material>();
  private originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private targetMaterial = new THREE.MeshBasicMaterial({ color: HIGHLIGHT, transparent: true, opacity: 0.45, depthWrite: false });
  private ghostMaterial = new THREE.MeshBasicMaterial({ color: HIGHLIGHT, transparent: true, opacity: 0.12, depthWrite: false });
  private held: THREE.Object3D | null = null;
  private heldOriginals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private loader = new LDrawLoader();
  private loadId = 0;

  /** center: where the set's footprint is centred, in world units on the baseplate. */
  constructor(private center = new THREE.Vector3()) {}

  /** Bounds of the whole finished set (excluding the piece in hand). */
  bounds(): THREE.Box3 {
    return this.model ? new THREE.Box3().setFromObject(this.model) : new THREE.Box3();
  }

  get total() {
    return this.pieces.length;
  }

  get complete() {
    return this.placed >= this.pieces.length;
  }

  /** Step of the next piece to place (build mode). */
  get buildStep() {
    return this.pieces[Math.min(this.placed, this.pieces.length - 1)]?.step ?? 0;
  }

  async load(info: SetInfo) {
    const id = ++this.loadId;
    const model = await this.loader.loadAsync(`${import.meta.env.BASE_URL}ldraw/models/${encodeURIComponent(info.file)}`);
    if (id !== this.loadId) return; // a newer load started meanwhile

    if (this.model) this.root.remove(this.model);
    this.dropHeld();
    this.originals.clear();
    this.glowMaterials.clear();

    model.rotation.x = Math.PI;
    model.scale.setScalar(LDU);
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    // Sit the set on the baseplate, centred on `center`.
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const c = box.getCenter(new THREE.Vector3());
    model.position.set(this.center.x - c.x, -box.min.y, this.center.z - c.z);
    model.updateMatrixWorld(true);

    this.model = model;
    this.info = info;
    this.numSteps = model.userData.numBuildingSteps ?? 1;
    this.pieces = collectPieces(model);
    this.placed = 0;
    this.root.add(model);
    this.setMode(this.mode);
  }

  setMode(mode: SetMode) {
    this.mode = mode;
    if (mode === 'built') {
      this.dropHeld();
      this.setStep(this.numSteps - 1, false);
    } else {
      this.refreshBuild();
    }
  }

  /** Built mode: shows steps 0..step. With `glow`, the parts added in `step` light up. */
  setStep(step: number, glow = true) {
    if (!this.model || this.mode !== 'built') return;
    this.step = Math.min(Math.max(step, 0), this.numSteps - 1);
    const showGlow = glow && this.numSteps > 1;
    this.model.traverse((o) => {
      if ((o as THREE.Group).isGroup) o.visible = (o.userData.buildingStep ?? 0) <= this.step;
      if ((o as THREE.LineSegments).isLineSegments) o.visible = true;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const original = this.original(mesh);
      mesh.material = showGlow && stepOf(mesh) === this.step ? this.glow(original) : original;
    });
  }

  /**
   * Build mode, once per frame: moves the held piece to follow the cursor ray and places it
   * on a press if it is snapped. Returns what happened to a press ('placed' or 'miss').
   */
  updateHeld(ray: THREE.Ray | null, pressStarted: boolean): 'placed' | 'miss' | null {
    if (this.mode !== 'build' || this.complete || !this.held) return null;
    const piece = this.pieces[this.placed];
    const hit = ray?.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -piece.center.y), new THREE.Vector3());
    if (!hit) {
      this.held.visible = false;
      return null;
    }
    const offset = hit.clone().sub(piece.center).setY(0);
    const snapped = offset.length() < SNAP_RADIUS;
    if (snapped) offset.set(0, 0, 0);

    this.held.visible = true;
    this.held.matrix.makeTranslation(offset.x, offset.y, offset.z).multiply(piece.obj.matrixWorld);
    for (const [mesh, original] of this.heldOriginals) mesh.material = snapped ? this.glow(original) : original;

    if (!pressStarted) return null;
    if (!snapped) return 'miss';
    this.placeNext();
    return 'placed';
  }

  /** Build mode: places the current piece (used on snap, and as "do this one for me"). */
  placeNext() {
    if (this.mode !== 'build' || this.complete) return;
    this.placed++;
    this.refreshBuild();
  }

  /** Build mode: takes back the last placed piece. */
  undoPiece(): boolean {
    if (this.mode !== 'build' || this.placed === 0) return false;
    this.placed--;
    this.refreshBuild();
    return true;
  }

  private refreshBuild() {
    if (!this.model) return;
    // Visibility is decided per piece in build mode, so open up all the step groups.
    this.model.traverse((o) => {
      if ((o as THREE.Group).isGroup) o.visible = true;
    });
    const step = this.buildStep;
    this.pieces.forEach((p, i) => {
      const state: PieceState =
        i < this.placed ? 'placed' : i === this.placed ? 'target' : p.step === step ? 'ghost' : 'hidden';
      this.applyState(p, state);
    });
    this.step = step;
    this.makeHeld();
  }

  private applyState(p: Piece, state: PieceState) {
    p.obj.visible = state !== 'hidden';
    p.obj.traverse((o) => {
      if ((o as THREE.LineSegments).isLineSegments) o.visible = state === 'placed';
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const original = this.original(mesh);
      mesh.material = state === 'placed' ? original : state === 'target' ? this.targetMaterial : this.ghostMaterial;
      mesh.castShadow = state === 'placed';
    });
  }

  /** The piece in the user's hand: a copy of the next piece with its real colors. */
  private makeHeld() {
    this.dropHeld();
    if (this.complete) return;
    const piece = this.pieces[this.placed];
    const held = piece.obj.clone();
    held.matrixAutoUpdate = false;
    held.visible = false;
    held.traverse((o) => {
      o.visible = true;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const source = findSource(piece.obj, held, mesh);
      const original = source ? this.original(source) : mesh.material;
      mesh.material = original;
      mesh.castShadow = true;
      this.heldOriginals.set(mesh, original);
    });
    // The clone keeps its local transform; updateHeld() sets its full matrix each frame.
    held.matrixWorldAutoUpdate = true;
    this.held = held;
    this.root.add(held);
  }

  private dropHeld() {
    if (this.held) this.root.remove(this.held);
    this.held = null;
    this.heldOriginals.clear();
  }

  private original(mesh: THREE.Mesh) {
    if (!this.originals.has(mesh)) this.originals.set(mesh, mesh.material);
    return this.originals.get(mesh)!;
  }

  private glow(m: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
    if (Array.isArray(m)) return m.map((x) => this.glow(x) as THREE.Material);
    let g = this.glowMaterials.get(m);
    if (!g) {
      g = m.clone();
      if ((g as THREE.MeshStandardMaterial).emissive) {
        (g as THREE.MeshStandardMaterial).emissive.copy(HIGHLIGHT);
        (g as THREE.MeshStandardMaterial).emissiveIntensity = 0.45;
      }
      this.glowMaterials.set(m, g);
    }
    return g;
  }
}

const isPart = (o: THREE.Object3D) => (o as THREE.Group).isGroup && /part|shortcut/i.test(o.userData.type ?? '');

/** Top-level parts (not sub-parts of other parts) in instruction order. */
function collectPieces(model: THREE.Group): Piece[] {
  const pieces: Piece[] = [];
  const walk = (o: THREE.Object3D) => {
    if (isPart(o)) {
      const center = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
      pieces.push({ obj: o as THREE.Group, step: stepOf(o, true), center });
      return;
    }
    o.children.forEach(walk);
  };
  walk(model);
  // Stable sort keeps file order within a step.
  return pieces.map((p, i) => ({ p, i })).sort((a, b) => a.p.step - b.p.step || a.i - b.i).map((x) => x.p);
}

/** Building step of an object (its own if `self` and set, else the nearest enclosing group's). */
function stepOf(o: THREE.Object3D, self = false): number {
  let p: THREE.Object3D | null = self ? o : o.parent;
  while (p && p.userData.buildingStep === undefined) p = p.parent;
  return p?.userData.buildingStep ?? 0;
}

/** Finds the mesh in `source` at the same position in the tree as `mesh` is in `clone`. */
function findSource(source: THREE.Object3D, clone: THREE.Object3D, mesh: THREE.Object3D): THREE.Mesh | null {
  const path: number[] = [];
  for (let o: THREE.Object3D | null = mesh; o && o !== clone; o = o.parent) path.unshift(o.parent!.children.indexOf(o));
  let s: THREE.Object3D = source;
  for (const i of path) s = s.children[i];
  return (s as THREE.Mesh).isMesh ? (s as THREE.Mesh) : null;
}
