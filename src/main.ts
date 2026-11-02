import { HandInput } from './input/hand';
import type { GestureDetector } from './input/gestures';
import { drawHandDebug } from './input/handDebug';
import { MouseInput } from './input/mouse';
import type { InputSource } from './input/types';
import { BuildModel } from './model/build';
import { PALETTE } from './model/bricks';
import { BuildView } from './scene/view';
import { LDrawSetView, SETS } from './scene/ldrawSet';
import * as THREE from 'three';
import { Interaction } from './app/interaction';

const GESTURE_NAMES = { none: 'not seen', open: 'open', pinch: 'pinch', middle: 'middle pinch', fist: 'fist' };
function describe(g: GestureDetector) {
  const m = g.metrics;
  return m ? `${GESTURE_NAMES[g.gesture]} · idx ${m.index.toFixed(2)} mid ${m.middle.toFixed(2)} curl ${m.curl.toFixed(2)}` : 'not seen';
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const model = new BuildModel(32, 32);
const view = new BuildView($('stage'), model);
const interaction = new Interaction(model, view);
const mouse = new MouseInput();
const hand = new HandInput();
const sources: InputSource[] = [hand, mouse];

// A real LEGO set on the left half of the baseplate; the right half stays free for building.
const setView = new LDrawSetView(new THREE.Vector3(-model.width / 6, 0, -model.depth / 8));
view.scene.add(setView.root);
let setIndex = 0;
async function showSet(i: number) {
  setIndex = (i + SETS.length) % SETS.length;
  try {
    await setView.load(SETS[setIndex]);
    frameSet();
  } catch (e) {
    interaction.notify(`Couldn't load ${SETS[setIndex].name}`);
    console.error(e);
  }
}
void showSet(0);

interaction.extraAction = (action, value) => {
  const building = setView.mode === 'build';
  if (action === 'step' && building) {
    // Build mode: back = take the last piece back, next = place this piece for me.
    if (Number(value) < 0) setView.undoPiece();
    else setView.placeNext();
  } else if (action === 'step') setView.setStep(setView.step + Number(value));
  else if (action === 'set') void showSet(setIndex + 1);
  else if (action === 'setmode') setView.setMode(value === 'built' ? 'built' : 'build');
  else if (action === 'undo' && building) return setView.undoPiece() || true;
  else return false;
  syncSetButtons();
  return true;
};

// Build mode: the hand (or mouse) carries the next piece of the set over the build area.
interaction.buildAreaOverride = (cursor, pressStarted) => {
  if (setView.mode !== 'build' || setView.complete) return false;
  const result = setView.updateHeld(cursor ? view.rayAt(cursor) : null, pressStarted);
  if (result === 'miss') interaction.warn('Move the piece onto its glowing spot');
  if (result === 'placed' && setView.complete) interaction.notify(`${setView.info?.name} complete`);
  return true;
};

/** Frames the set closely enough that single pieces are easy to see and carry. */
function frameSet() {
  const box = setView.bounds();
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  view.focus(box.getCenter(new THREE.Vector3()).setY(size.y / 3), Math.max(size.x, size.z, size.y) * 1.6 + 8);
}

function syncSetButtons() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-action="setmode"]')) {
    el.classList.toggle('selected', el.dataset.value === setView.mode);
  }
}
syncSetButtons();

function setProjectorMode(on: boolean) {
  document.body.classList.toggle('projector', on);
  view.setProjectorMode(on);
  if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

for (const color of PALETTE) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swatch';
  b.style.background = color;
  b.dataset.action = 'color';
  b.dataset.value = color;
  b.setAttribute('aria-label', `Color ${color}`);
  $('swatches').appendChild(b);
}

// Pointer presses are handled in the frame loop, so tray buttons only react to keyboard activation here.
document.querySelectorAll<HTMLElement>('[data-action]').forEach((el) =>
  el.addEventListener('click', (e) => {
    if ((e as MouseEvent).detail === 0) interaction.runAction(el.dataset.action!, el.dataset.value);
  }),
);
model.onChange(() => interaction.syncTray());
interaction.syncTray();

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    interaction.runAction(e.shiftKey ? 'redo' : 'undo');
  } else if (e.key === 'r' || e.key === 'R') interaction.runAction('rotate');
  else if (e.key === 'q' || e.key === 'Q') interaction.runAction('view', '-45');
  else if (e.key === 'e' || e.key === 'E') interaction.runAction('view', '45');
  else if (e.key === 'Escape') interaction.runAction('empty');
  else if (e.key === 'ArrowRight') interaction.runAction('step', '1');
  else if (e.key === 'ArrowLeft') interaction.runAction('step', '-1');
  else if (e.key === 'n' || e.key === 'N') interaction.runAction('set');
  else if (e.key === 'b' || e.key === 'B') interaction.runAction('setmode', setView.mode === 'build' ? 'built' : 'build');
  else if (e.key === 'p' || e.key === 'P') setProjectorMode(!document.body.classList.contains('projector'));
  else if (e.key === '0') view.resetView();
  else if (e.key === '9') frameSet();
  else if (e.key === '1') interaction.runAction('type', '2x2');
  else if (e.key === '2') interaction.runAction('type', '2x4');
});

$('hand-start').addEventListener('click', async () => {
  await hand.start();
  $('hand-start').style.display = hand.status === 'running' ? 'none' : '';
  await fillCameraList();
});

const cameraSelect = $<HTMLSelectElement>('camera-select');
async function fillCameraList() {
  const cams = await HandInput.listCameras();
  const active = (hand.video.srcObject as MediaStream | null)?.getVideoTracks()[0]?.getSettings().deviceId ?? hand.deviceId;
  cameraSelect.replaceChildren(
    ...cams.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId, false, c.deviceId === active)),
  );
}
cameraSelect.addEventListener('change', () => void hand.useCamera(cameraSelect.value));
navigator.mediaDevices?.addEventListener?.('devicechange', () => void fillCameraList());
void fillCameraList();

$('projector-toggle').addEventListener('click', () => setProjectorMode(!document.body.classList.contains('projector')));
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('projector')) setProjectorMode(false);
});

$('hand-swap').addEventListener('click', () => {
  hand.swapHands = !hand.swapHands;
});

// View hand gains: a full sweep across the camera turns the build about 270°.
const YAW_GAIN = Math.PI * 1.5;
const TILT_GAIN = Math.PI * 0.8;
const ZOOM_GAIN = 1.5;

const cursorEl = $('cursor');
const seenPresses = new Map<string, number>();

function frame(now: number) {
  hand.update(now);

  // The device the user touched most recently drives the cursor.
  const active = sources
    .filter((s) => s.frame().cursor)
    .sort((a, b) => b.frame().lastActive - a.frame().lastActive)[0];
  const f = active?.frame();
  const pressStarted = !!f && f.pressCount !== (seenPresses.get(active.name) ?? 0);
  for (const s of sources) seenPresses.set(s.name, s.frame().pressCount);

  // Grab the world: the build turns the way the hand moves, so the camera goes the opposite way.
  const vd = hand.consumeViewDelta();
  if (vd.dx || vd.dy || vd.zoom !== 1) view.orbitBy(-vd.dx * YAW_GAIN, -vd.dy * TILT_GAIN, Math.pow(vd.zoom, ZOOM_GAIN));

  for (const ev of hand.events.splice(0)) {
    if (ev === 'cancel' && interaction.held) {
      interaction.runAction('empty');
      interaction.notify('✊ Cancelled: hand is empty');
    } else if (ev === 'undo') {
      interaction.runAction('undo');
      interaction.notify(setView.mode === 'build' ? '↶ Took back the last piece' : '↶ Undo');
    }
  }

  interaction.update(f?.cursor ?? null, pressStarted, now);
  view.render();

  const showDot = active === hand && !!f?.cursor;
  cursorEl.style.display = showDot ? 'block' : 'none';
  if (showDot && f?.cursor) {
    cursorEl.style.transform = `translate(${f.cursor.x * innerWidth}px, ${f.cursor.y * innerHeight}px)`;
    cursorEl.classList.toggle('pressed', f.pressed);
  }

  $('hud-source').textContent = `Input: ${active === hand ? 'Hand' : 'Mouse'}`;
  const s = setView.info;
  $('hud-set').textContent = !s
    ? 'Loading set…'
    : setView.mode === 'built'
      ? `${s.name} (${s.id}) · step ${setView.step + 1} of ${setView.numSteps}`
      : setView.complete
        ? `${s.name} (${s.id}) · complete`
        : `${s.name} (${s.id}) · piece ${setView.placed + 1} of ${setView.total} · step ${setView.step + 1} of ${setView.numSteps}`;
  const held = interaction.held;
  $('hud-held').textContent =
    setView.mode === 'build' && !setView.complete
      ? 'Holding the next piece'
      : held
        ? `Holding ${held.type} at ${held.rot}°`
        : 'Holding nothing';
  $('hud-message').textContent = interaction.message;
  $('hud-message').className = interaction.messageKind;
  const buildSide = hand.swapHands ? 'Left' : 'Right';
  const viewSide = hand.swapHands ? 'Right' : 'Left';
  $('hand-status').innerHTML =
    hand.status === 'running'
      ? `<span class="build">${buildSide} (build): ${describe(hand.gestures)}</span><br>` +
        `<span class="view">${viewSide} (view): ${describe(hand.viewGestures)}</span>`
      : hand.status === 'loading'
        ? 'Starting camera and model…'
        : hand.status === 'error'
          ? `Error: ${hand.error}`
          : 'Camera off. Mouse works: left-click places, right-drag orbits.';
  if (hand.status === 'running') drawHandDebug($('hand-debug'), hand);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Exposed for debugging in the browser console.
Object.assign(window, { model, view, hand, interaction, setView });
