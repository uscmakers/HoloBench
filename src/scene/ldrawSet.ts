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

// LDraw units: 1 stud = 20 LDU, and +y points down.
const LDU = 1 / 20;
const HIGHLIGHT = new THREE.Color('#4fd8ff');

/**
 * A real LEGO set rendered from an LDraw file, with its official building steps.
 * Steps up to `step` are shown; the parts added in `step` itself glow so the newest
 * bricks stand out (a first version of guided building).
 */
export class LDrawSetView {
  readonly root = new THREE.Group();
  info: SetInfo | null = null;
  step = 0;
  numSteps = 0;
  private model: THREE.Group | null = null;
  private glowMaterials = new Map<THREE.Material, THREE.Material>();
  private originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private loader = new LDrawLoader();
  private loadId = 0;

  /** center: where the set's footprint is centred, in world units on the baseplate. */
  constructor(private center = new THREE.Vector3()) {}

  async load(info: SetInfo) {
    const id = ++this.loadId;
    const model = await this.loader.loadAsync(`${import.meta.env.BASE_URL}ldraw/models/${encodeURIComponent(info.file)}`);
    if (id !== this.loadId) return; // a newer load started meanwhile

    if (this.model) this.root.remove(this.model);
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

    this.model = model;
    this.info = info;
    this.numSteps = model.userData.numBuildingSteps ?? 1;
    this.root.add(model);
    this.setStep(this.numSteps - 1, false);
  }

  /** Shows steps 0..step. With `glow`, the parts added in `step` light up. */
  setStep(step: number, glow = true) {
    if (!this.model) return;
    this.step = Math.min(Math.max(step, 0), this.numSteps - 1);
    const showGlow = glow && this.numSteps > 1;
    this.model.traverse((o) => {
      if ((o as THREE.Group).isGroup) o.visible = (o.userData.buildingStep ?? 0) <= this.step;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!this.originals.has(mesh)) this.originals.set(mesh, mesh.material);
      const original = this.originals.get(mesh)!;
      const newest = showGlow && stepOf(mesh) === this.step;
      mesh.material = newest ? this.glow(original) : original;
    });
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

/** Building step of the nearest enclosing group. */
function stepOf(o: THREE.Object3D): number {
  let p: THREE.Object3D | null = o.parent;
  while (p && p.userData.buildingStep === undefined) p = p.parent;
  return p?.userData.buildingStep ?? 0;
}
