import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BRICK_DEFS, type Brick, type Placement, footprintSize } from '../model/bricks';
import type { BuildModel } from '../model/build';

// World units: 1 stud = 1 unit (8 mm), so 1 plate = 0.4 units (3.2 mm).
const PLATE = 0.4;
const STUD_RADIUS = 0.3;
const STUD_HEIGHT = 0.2;
const GAP = 0.02; // visible seam between neighbouring bricks

const studGeometry = new THREE.CylinderGeometry(STUD_RADIUS, STUD_RADIUS, STUD_HEIGHT, 20);

/** Renders a BuildModel with Three.js. Holds no build state of its own. */
export class BuildView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
  readonly controls: OrbitControls;

  private brickMeshes = new Map<string, { key: string; obj: THREE.Object3D }>();
  private materials = new Map<string, THREE.MeshStandardMaterial>();
  private pickTargets: THREE.Object3D[] = [];
  private ghost: THREE.Object3D | null = null;
  private ghostKey = '';
  private ghostMaterial = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.55, depthWrite: false });
  private raycaster = new THREE.Raycaster();
  private hiddenId: string | null = null;
  private pendingYaw = 0; // radians still to turn the view

  constructor(
    private container: HTMLElement,
    private model: BuildModel,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color('#070a12');
    this.scene.fog = new THREE.Fog('#070a12', 60, 120);
    this.scene.add(new THREE.HemisphereLight('#bfd9ff', '#1a1d26', 1.1));
    const sun = new THREE.DirectionalLight('#ffffff', 2.2);
    sun.position.set(18, 30, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = Math.max(model.width, model.depth) * 0.7;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 100 });
    this.scene.add(sun);

    this.camera.position.copy(this.homePosition());
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // Left button is "pinch" (place bricks); right-drag orbits, wheel zooms.
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE } as never;
    this.controls.target.set(0, 0, 0);
    this.controls.maxPolarAngle = Math.PI * 0.45;
    this.controls.enableDamping = true;

    this.buildBaseplate();
    model.onChange(() => this.sync());
    this.sync();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  /** Grid point (continuous stud coordinates) under a viewport position (0..1), or null if it hits nothing. */
  pick(cursor: { x: number; y: number }): { gx: number; gz: number } | null {
    this.raycaster.setFromCamera(new THREE.Vector2(cursor.x * 2 - 1, -(cursor.y * 2 - 1)), this.camera);
    const hit = this.raycaster.intersectObjects(this.pickTargets.filter((o) => o.visible), true)[0];
    if (!hit) return null;
    // Step slightly into the surface so pointing at a brick's side means "on top of that brick".
    const p = hit.point.clone().addScaledVector(this.raycaster.ray.direction, 0.05);
    return { gx: p.x + this.model.width / 2, gz: p.z + this.model.depth / 2 };
  }

  /** Brick id under a viewport position, if any. */
  brickAt(cursor: { x: number; y: number }): string | null {
    this.raycaster.setFromCamera(new THREE.Vector2(cursor.x * 2 - 1, -(cursor.y * 2 - 1)), this.camera);
    const objs = [...this.brickMeshes.values()].map((m) => m.obj).filter((o) => o.visible);
    const hit = this.raycaster.intersectObjects(objs, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && !o.userData.brickId) o = o.parent;
    return o?.userData.brickId ?? null;
  }

  /** Shows the translucent preview brick, green when valid, red when not. */
  setGhost(p: Placement | null, color: string, valid: boolean) {
    if (!p) {
      if (this.ghost) this.ghost.visible = false;
      return;
    }
    const key = `${p.type}/${p.rot}`;
    if (!this.ghost || key !== this.ghostKey) {
      if (this.ghost) this.scene.remove(this.ghost);
      this.ghost = makeBrick(p, this.ghostMaterial, false);
      this.ghostKey = key;
      this.scene.add(this.ghost);
    }
    this.ghost.visible = true;
    placeObject(this.ghost, p, this.model);
    this.ghostMaterial.color.set(valid ? color : '#ff3b3b');
    this.ghostMaterial.emissive.set(valid ? '#1d6b3a' : '#7a0000');
    this.ghostMaterial.opacity = valid ? 0.6 : 0.45;
  }

  /** Hides a placed brick (while it is being carried). */
  setHidden(id: string | null) {
    this.hiddenId = id;
    for (const [bid, m] of this.brickMeshes) m.obj.visible = bid !== id;
  }

  /**
   * Orbits the camera around the build. dYaw/dTilt in radians; positive tilt looks more from above.
   * zoom > 1 moves closer.
   */
  orbitBy(dYaw: number, dTilt: number, zoom = 1) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const s = new THREE.Spherical().setFromVector3(offset);
    s.theta += dYaw;
    s.phi = Math.min(Math.max(s.phi - dTilt, 0.12), this.controls.maxPolarAngle);
    s.radius = Math.min(Math.max(s.radius / zoom, 12), 110);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(s));
  }

  resetView() {
    this.pendingYaw = 0;
    this.controls.target.set(0, 0, 0);
    this.camera.position.copy(this.homePosition());
  }

  private homePosition() {
    return new THREE.Vector3(0, this.model.depth * 0.95, this.model.depth * 1.05);
  }

  /** Turns the view around the build's vertical axis, animated. */
  turnView(degrees: number) {
    this.pendingYaw += (degrees * Math.PI) / 180;
  }

  render() {
    if (Math.abs(this.pendingYaw) > 1e-4) {
      const step = this.pendingYaw * 0.18;
      this.pendingYaw -= step;
      const offset = this.camera.position.clone().sub(this.controls.target);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), step);
      this.camera.position.copy(this.controls.target).add(offset);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private sync() {
    const live = new Set<string>();
    for (const b of this.model.getBricks()) {
      live.add(b.id);
      const key = `${b.type}/${b.rot}/${b.color}`;
      let entry = this.brickMeshes.get(b.id);
      if (!entry || entry.key !== key) {
        if (entry) this.removeBrick(b.id);
        const obj = makeBrick(b, this.material(b.color), true);
        obj.userData.brickId = b.id;
        this.scene.add(obj);
        this.pickTargets.push(obj);
        entry = { key, obj };
        this.brickMeshes.set(b.id, entry);
      }
      placeObject(entry.obj, b, this.model);
      entry.obj.visible = b.id !== this.hiddenId;
    }
    for (const id of [...this.brickMeshes.keys()]) if (!live.has(id)) this.removeBrick(id);
  }

  private removeBrick(id: string) {
    const entry = this.brickMeshes.get(id);
    if (!entry) return;
    this.scene.remove(entry.obj);
    this.pickTargets = this.pickTargets.filter((o) => o !== entry.obj);
    this.brickMeshes.delete(id);
  }

  private material(color: string) {
    let m = this.materials.get(color);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.0 });
      this.materials.set(color, m);
    }
    return m;
  }

  private buildBaseplate() {
    const { width: W, depth: D } = this.model;
    const mat = new THREE.MeshStandardMaterial({ color: '#2b3a55', roughness: 0.6 });
    const plate = new THREE.Mesh(new THREE.BoxGeometry(W, PLATE, D), mat);
    plate.position.y = -PLATE / 2;
    plate.receiveShadow = true;
    this.scene.add(plate);
    this.pickTargets.push(plate);

    const studs = new THREE.InstancedMesh(studGeometry, mat, W * D);
    const m = new THREE.Matrix4();
    let i = 0;
    for (let x = 0; x < W; x++) {
      for (let z = 0; z < D; z++) {
        m.setPosition(x + 0.5 - W / 2, STUD_HEIGHT / 2, z + 0.5 - D / 2);
        studs.setMatrixAt(i++, m);
      }
    }
    studs.receiveShadow = true;
    this.scene.add(studs);

    // Holographic edge glow.
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(W + 0.1, PLATE, D + 0.1)),
      new THREE.LineBasicMaterial({ color: '#4fd8ff', transparent: true, opacity: 0.7 }),
    );
    edges.position.y = -PLATE / 2;
    this.scene.add(edges);
  }
}

/** A brick mesh with its origin at the min corner of its footprint, bottom face at y = 0. */
function makeBrick(p: Placement, material: THREE.Material, shadows: boolean): THREE.Object3D {
  const { w, d } = footprintSize(p.type, p.rot);
  const h = BRICK_DEFS[p.type].height * PLATE;
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(w - GAP, h - GAP, d - GAP), material);
  body.position.set(w / 2, h / 2, d / 2);
  group.add(body);
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < d; j++) {
      const stud = new THREE.Mesh(studGeometry, material);
      stud.position.set(i + 0.5, h + STUD_HEIGHT / 2 - GAP / 2, j + 0.5);
      group.add(stud);
    }
  }
  group.traverse((o) => {
    o.castShadow = shadows;
    o.receiveShadow = shadows;
  });
  return group;
}

function placeObject(obj: THREE.Object3D, p: Placement | Brick, model: BuildModel) {
  obj.position.set(p.x - model.width / 2, p.y * PLATE, p.z - model.depth / 2);
}
