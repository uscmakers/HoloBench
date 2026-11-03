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
 * order. The first piece goes anywhere on the baseplate (snapped to the studs,
 * turned in 90° steps) and anchors the whole set. After that each piece follows
 * the cursor on a horizontal plane at its final height (so no depth input is
 * needed), its spot glows, the rest of the step shows as a faint ghost, and the
 * piece snaps in once it is close enough.
 */
export class LDrawSetView {
  readonly root = new THREE.Group();
  info: SetInfo | null = null;
  mode: SetMode = 'build';
  step = 0;
  numSteps = 0;
  /** Build mode: number of pieces placed so far. */
  placed = 0;
  /** Build mode: whether the first piece is down, fixing where the set stands. */
  anchored = false;
  /** Quarter turns of the set around its first piece. */
  turns = 0;
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
  /** Carries the set: sits where the first piece goes, turned by `turns`. Pieces are in its coordinates. */
  private anchor = new THREE.Group();
  /** Footprint of the first piece in studs (unturned), to snap it onto the baseplate studs. */
  private firstSize = { w: 2, d: 2 };
  /** Build mode: how far redo can go, and where the first piece was if it was undone. */
  private redoTo = 0;
  private lastAnchor = { x: 0, z: 0, turns: 0 };

  /**
   * center: default spot for the first piece (built mode, or "place it for me"), in world units.
   * halfSize: half the baseplate size, to keep the first piece on it.
   */
  constructor(
    private center = new THREE.Vector3(),
    private halfSize = 16,
  ) {
    this.root.add(this.anchor);
  }

  /** Bounds of the whole finished set where it stands now (excluding the piece in hand). */
  bounds(): THREE.Box3 {
    return this.model ? new THREE.Box3().setFromObject(this.model) : new THREE.Box3();
  }

  get total() {
    return this.pieces.length;
  }

  get complete() {
    return this.placed >= this.pieces.length;
  }

  get canUndo() {
    return this.mode === 'build' && this.placed > 0;
  }

  get canRedo() {
    return this.mode === 'build' && this.placed < this.redoTo;
  }

  /** Step of the next piece to place (build mode). */
  get buildStep() {
    return this.pieces[Math.min(this.placed, this.pieces.length - 1)]?.step ?? 0;
  }

  async load(info: SetInfo) {
    const id = ++this.loadId;
    const model = await this.loader.loadAsync(`${import.meta.env.BASE_URL}ldraw/models/${encodeURIComponent(info.file)}`);
    if (id !== this.loadId) return; // a newer load started meanwhile

    if (this.model) this.anchor.remove(this.model);
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
    // In anchor coordinates the set stands on y = 0 with its first piece centred on the origin.
    this.anchor.position.set(0, 0, 0);
    this.anchor.rotation.set(0, 0, 0);
    this.anchor.add(model);
    this.anchor.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const pieces = collectPieces(model);
    const first = pieces[0];
    const firstBox = new THREE.Box3().setFromObject(first.obj);
    const shift = new THREE.Vector3(-first.center.x, -box.min.y, -first.center.z);
    model.position.add(shift);
    model.updateMatrixWorld(true);
    for (const p of pieces) p.center.add(shift);
    const size = firstBox.getSize(new THREE.Vector3());
    this.firstSize = { w: Math.max(1, Math.round(size.x)), d: Math.max(1, Math.round(size.z)) };

    this.model = model;
    this.info = info;
    this.numSteps = model.userData.numBuildingSteps ?? 1;
    this.pieces = pieces;
    this.placed = 0;
    this.redoTo = 0;
    this.anchored = false;
    this.turns = 0;
    this.placeAnchor(this.defaultSpot());
    this.setMode(this.mode);
  }

  setMode(mode: SetMode) {
    this.mode = mode;
    if (mode === 'built') {
      this.dropHeld();
      if (!this.anchored) this.placeAnchor(this.defaultSpot());
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
    // The anchor only turns about y and sits at y = 0, so the piece's height is the same in world space.
    const hit = ray?.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -piece.center.y), new THREE.Vector3());
    if (!hit) {
      this.held.visible = false;
      return null;
    }

    if (!this.anchored) {
      // First piece: it is free, and carries the (still hidden) set with it.
      this.placeAnchor(this.snap(hit.x, hit.z, this.turns));
      this.held.visible = true;
      this.held.matrix.copy(piece.obj.matrixWorld);
      if (!pressStarted) return null;
      this.anchored = true;
      this.placed = 1;
      this.redoTo = 1;
      this.refreshBuild();
      return 'placed';
    }

    const target = piece.center.clone().applyMatrix4(this.anchor.matrixWorld);
    const offset = hit.clone().sub(target).setY(0);
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
    if (!this.anchored) {
      this.placeAnchor(this.defaultSpot());
      this.anchored = true;
      this.redoTo = 0;
    }
    this.placed++;
    // Later pieces always go to the same spots, so placing one again keeps the redo history.
    this.redoTo = Math.max(this.redoTo, this.placed);
    this.refreshBuild();
  }

  /** Build mode: takes back the last placed piece. Taking back the first one frees the set to go elsewhere. */
  undoPiece(): boolean {
    if (!this.canUndo) return false;
    this.placed--;
    if (this.placed === 0) {
      this.lastAnchor = { x: this.anchor.position.x, z: this.anchor.position.z, turns: this.turns };
      this.anchored = false;
    }
    this.refreshBuild();
    return true;
  }

  /** Build mode: puts back the piece taken back last (the first one where it was). */
  redoPiece(): boolean {
    if (!this.canRedo) return false;
    if (!this.anchored) {
      this.turns = this.lastAnchor.turns;
      this.placeAnchor(this.lastAnchor);
      this.anchored = true;
    }
    this.placed++;
    this.refreshBuild();
    return true;
  }

  /** Build mode, before the first piece is down: turns the set a quarter turn. False once it is anchored. */
  turn(): boolean {
    if (this.mode !== 'build' || this.anchored) return false;
    this.turns = (this.turns + 1) % 4;
    return true;
  }

  /** Where the first piece goes by default: `center`, snapped to the studs. */
  private defaultSpot() {
    return this.snap(this.center.x, this.center.z, this.turns);
  }

  /**
   * Snaps the first piece's centre so its studs sit on the baseplate's: an even number of studs
   * centres on a seam (whole number), an odd number on a stud (half). Keeps it on the baseplate.
   */
  private snap(x: number, z: number, turns: number) {
    const { w, d } = turns % 2 ? { w: this.firstSize.d, d: this.firstSize.w } : this.firstSize;
    const axis = (v: number, n: number) => {
      const limit = this.halfSize - n / 2;
      const clamped = Math.min(Math.max(v, -limit), limit);
      return n % 2 ? Math.floor(clamped) + 0.5 : Math.round(clamped);
    };
    return { x: axis(x, w), z: axis(z, d), turns };
  }

  private placeAnchor(spot: { x: number; z: number; turns: number }) {
    this.anchor.position.set(spot.x, 0, spot.z);
    this.anchor.rotation.y = (spot.turns * Math.PI) / 2;
    this.anchor.updateMatrixWorld(true);
  }

  private refreshBuild() {
    if (!this.model) return;
    // Visibility is decided per piece in build mode, so open up all the step groups.
    this.model.traverse((o) => {
      if ((o as THREE.Group).isGroup) o.visible = true;
    });
    const step = this.buildStep;
    this.pieces.forEach((p, i) => {
      // Until the first piece is down there is nowhere to show the rest.
      const state: PieceState = !this.anchored
        ? 'hidden'
        : i < this.placed
          ? 'placed'
          : i === this.placed
            ? 'target'
            : p.step === step
              ? 'ghost'
              : 'hidden';
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

export interface SetPreview {
  /** PNG data URL of the finished set. */
  image: string;
  pieces: number;
  steps: number;
}

const previews = new Map<string, Promise<SetPreview>>();

/** A picture and size of a set for the set gallery, rendered once and cached. */
export function previewSet(info: SetInfo): Promise<SetPreview> {
  let p = previews.get(info.id);
  if (!p) {
    p = renderPreview(info);
    previews.set(info.id, p);
  }
  return p;
}

async function renderPreview(info: SetInfo): Promise<SetPreview> {
  const model = await new LDrawLoader().loadAsync(`${import.meta.env.BASE_URL}ldraw/models/${encodeURIComponent(info.file)}`);
  model.rotation.x = Math.PI;
  model.scale.setScalar(LDU);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;

  const scene = new THREE.Scene();
  scene.add(model, new THREE.HemisphereLight('#ffffff', '#445066', 2.2));
  const sun = new THREE.DirectionalLight('#ffffff', 2.5);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);
  const fov = 30;
  const camera = new THREE.PerspectiveCamera(fov, 4 / 3, 0.1, 1000);
  const distance = (radius / Math.sin(((fov / 2) * Math.PI) / 180)) * 0.9;
  camera.position.copy(center).addScaledVector(new THREE.Vector3(1, 0.9, 1.3).normalize(), distance);
  camera.lookAt(center);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(320, 240, false);
    renderer.render(scene, camera);
    return {
      image: renderer.domElement.toDataURL('image/png'),
      pieces: collectPieces(model).length,
      steps: model.userData.numBuildingSteps ?? 1,
    };
  } finally {
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
