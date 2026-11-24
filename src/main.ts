import { HandInput } from './input/hand';
import type { GestureDetector } from './input/gestures';
import { drawHandDebug } from './input/handDebug';
import { MouseInput } from './input/mouse';
import type { InputSource } from './input/types';
import { BuildModel } from './model/build';
import { BRICK_TYPES } from './model/bricks';
import { BuildView } from './scene/view';
import { LDrawSetView, SETS, previewSet } from './scene/ldrawSet';
import * as THREE from 'three';
import { Interaction } from './app/interaction';
import { studIcon } from './app/studIcon';

const GESTURE_NAMES = {
  none: 'not seen',
  open: 'open',
  pinch: 'pinch',
  middle: 'middle pinch',
  fist: 'fist',
  palm: 'open palm (menu)',
  grasp: 'grasp',
  point: 'point',
};
function describe(g: GestureDetector) {
  const m = g.metrics;
  return m
    ? `${GESTURE_NAMES[g.gesture]} · idx ${m.index.toFixed(2)} curl ${m.curl.toFixed(2)} spread ${m.spread.toFixed(2)} straight ${m.extended}/4`
    : 'not seen';
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const model = new BuildModel(32, 32);
const view = new BuildView($('stage'), model);
const interaction = new Interaction(model, view);
const mouse = new MouseInput();
const hand = new HandInput();
const sources: InputSource[] = [hand, mouse];

// A real LEGO set on the left half of the baseplate; the right half stays free for building.
const setView = new LDrawSetView(new THREE.Vector3(-model.width / 6, 0, -model.depth / 8), model.width / 2);
view.scene.add(setView.root);
let setIndex = 0;
/** Free build: no set, use the on-screen brick controls. */
let freeBuild = false;
/** True while the hand carries set pieces, so the right hand isn't free for loose bricks. */
const buildingSet = () => !freeBuild && setView.mode === 'build' && !setView.complete;

async function showSet(i: number) {
  freeBuild = false;
  document.body.classList.remove('free-build');
  setView.root.visible = true;
  setIndex = (i + SETS.length) % SETS.length;
  const info = SETS[setIndex];
  $('set-name').textContent = info.name;
  $('set-meta').textContent = info.id;
  void previewSet(info).then((p) => {
    if (SETS[setIndex] !== info || freeBuild) return;
    $<HTMLImageElement>('set-thumb').src = p.image;
    $('set-meta').textContent = `${info.id} · ${p.pieces} pieces · ${p.steps} steps`;
  });
  try {
    await setView.load(info);
    frameSet();
    interaction.syncTray();
  } catch (e) {
    interaction.notify(`Couldn't load ${info.name}`);
    console.error(e);
  }
}
void showSet(0);

function startFreeBuild() {
  freeBuild = true;
  document.body.classList.add('free-build');
  setView.root.visible = false;
  setView.updateHeld(null, false);
  $<HTMLImageElement>('set-thumb').removeAttribute('src');
  $('set-name').textContent = 'Free build';
  $('set-meta').textContent = 'Your own bricks';
  view.resetView();
}

const gallery = $('gallery');
function openGallery() {
  gallery.hidden = false;
  const card = (value: string, title: string, meta: string, thumb: string) => {
    const current = value === 'free' ? freeBuild : !freeBuild && Number(value) === setIndex;
    return (
      `<button type="button" class="gallery-card${current ? ' selected' : ''}" data-action="pickset" data-value="${value}">` +
      `<span class="thumb">${thumb}</span><b>${title}</b><span class="meta">${meta}</span></button>`
    );
  };
  $('gallery-grid').innerHTML =
    SETS.map((s, i) => card(String(i), s.name, s.id, `<img data-set="${i}" alt="" />`)).join('') +
    card('free', 'Free build', 'Empty baseplate, your own bricks', studIcon(2, 4));
  SETS.forEach((s, i) =>
    void previewSet(s).then((p) => {
      const img = gallery.querySelector<HTMLImageElement>(`img[data-set="${i}"]`);
      if (!img) return;
      img.src = p.image;
      img.closest('.gallery-card')!.querySelector('.meta')!.textContent = `${s.id} · ${p.pieces} pieces`;
    }),
  );
}

interaction.extraAction = (action, value) => {
  if (action === 'gallery') openGallery();
  else if (action === 'gallery-close') gallery.hidden = true;
  else if (action === 'pickset') {
    gallery.hidden = true;
    if (value === 'free') startFreeBuild();
    else void showSet(Number(value));
  }
  if (action === 'gallery' || action === 'gallery-close' || action === 'pickset') return true;
  if (freeBuild) return action === 'step' || action === 'set' || action === 'setmode';
  const building = setView.mode === 'build';
  if (action === 'step' && building) {
    // Build mode: back = take the last piece back, next = place this piece for me.
    if (Number(value) < 0) setView.undoPiece();
    else setView.placeNext();
  } else if (action === 'step') setView.setStep(setView.step + Number(value));
  else if (action === 'set') void showSet(setIndex + 1);
  else if (action === 'setmode') setView.setMode(value === 'built' ? 'built' : 'build');
  else if (action === 'undo' && building) setView.undoPiece();
  else if (action === 'redo' && building) setView.redoPiece();
  else if (action === 'rotate' && building && !setView.complete) {
    if (setView.turn()) interaction.notify('⟳ Turned the set');
    else interaction.warn('The set is anchored. Undo back to the first piece to turn it');
  } else return false;
  syncSetButtons();
  return true;
};

// While building a set, undo/redo walk through its pieces.
interaction.historyOverride = () =>
  !freeBuild && setView.mode === 'build' ? { canUndo: setView.canUndo, canRedo: setView.canRedo } : null;

// Brick size, color, and rotation controls live in fixed screen panels.
interaction.canDwell = () => false;
interaction.onAction = () => {};

// Build mode: the hand (or mouse) carries the next piece of the set over the build area.
interaction.buildAreaOverride = (cursor, pressStarted) => {
  if (!buildingSet()) return false;
  const result = setView.updateHeld(cursor ? view.rayAt(cursor) : null, pressStarted);
  if (result === 'miss') interaction.warn('Move the piece onto its glowing spot');
  if (result === 'placed') interaction.syncTray();
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
  else if (e.key === 'g' || e.key === 'G') {
    if (gallery.hidden) openGallery();
    else gallery.hidden = true;
  } else if (e.key === 'Escape') {
    if (!gallery.hidden) gallery.hidden = true;
    else interaction.runAction('empty');
  }
  else if (e.key === 'ArrowRight') interaction.runAction('step', '1');
  else if (e.key === 'ArrowLeft') interaction.runAction('step', '-1');
  else if (e.key === 'n' || e.key === 'N') interaction.runAction('set');
  else if (e.key === 'b' || e.key === 'B') interaction.runAction('setmode', setView.mode === 'build' ? 'built' : 'build');
  else if (e.key === 'p' || e.key === 'P') setProjectorMode(!document.body.classList.contains('projector'));
  else if (e.key === '0') view.resetView();
  else if (e.key === '9') frameSet();
  else if (e.key >= '1' && e.key <= String(BRICK_TYPES.length)) interaction.runAction('type', BRICK_TYPES[Number(e.key) - 1]);
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

function setStatus() {
  const s = setView.info;
  if (freeBuild) return 'Free build';
  if (!s) return 'Loading set…';
  const name = `${s.name} (${s.id})`;
  if (setView.mode === 'built') return `${name} · step ${setView.step + 1} of ${setView.numSteps}`;
  if (setView.complete) return `${name} · complete`;
  if (!setView.anchored) return `${name} · put the first piece anywhere · R or either fist turns the set`;
  return `${name} · piece ${setView.placed + 1} of ${setView.total} · step ${setView.step + 1} of ${setView.numSteps}`;
}

// View hand gains: a full sweep across the camera turns the build about 270°.
const YAW_GAIN = Math.PI * 1.5;
const TILT_GAIN = Math.PI * 0.8;
const ZOOM_GAIN = 1.5;

const handCursors = [$('cursor'), $('cursor-other')];
const seenPresses = new Map<string, number>();
const seenReleases = new Map<string, number>();

function frame(now: number) {
  hand.update(now);

  // The device the user touched most recently drives the cursor.
  const active = sources
    .filter((s) => s.frame().cursor)
    .sort((a, b) => b.frame().lastActive - a.frame().lastActive)[0];
  const f = active?.frame();
  let pressStarted = !!f && f.pressCount !== (seenPresses.get(active.name) ?? 0);
  const releaseStarted = !!f && f.releaseCount !== (seenReleases.get(active.name) ?? 0);
  for (const s of sources) {
    seenPresses.set(s.name, s.frame().pressCount);
    seenReleases.set(s.name, s.frame().releaseCount);
  }

  // Grab the world: the build turns the way the hand moves, so the camera goes the opposite way.
  const vd = hand.consumeViewDelta();
  if (vd.dx || vd.dy || vd.zoom !== 1) view.orbitBy(-vd.dx * YAW_GAIN, -vd.dy * TILT_GAIN, Math.pow(vd.zoom, ZOOM_GAIN));

  const settingUp = buildingSet();
  for (const ev of hand.events.splice(0)) {
    // Each carried stack handles its own hand opening, closing, or disappearing.
    if (interaction.hasHandBlockGrab) continue;
    // Right fist: while building a set it turns the set (before the first piece) or redoes; otherwise it empties the hand.
    if (ev === 'cancel' && settingUp && !setView.anchored) interaction.runAction('rotate');
    else if (ev === 'cancel' && settingUp) {
      if (setView.canRedo) {
        interaction.runAction('redo');
        interaction.notify('↷ Put the piece back');
      }
    } else if (ev === 'cancel') {
      interaction.runAction('empty');
      interaction.notify('✊ Cancelled the current action');
    }
  }

  // A click outside the set gallery closes it.
  if (pressStarted && f?.cursor && !gallery.hidden) {
    const el = document.elementFromPoint(f.cursor.x * innerWidth, f.cursor.y * innerHeight);
    if (!gallery.contains(el)) {
      gallery.hidden = true;
      pressStarted = false;
    }
  }

  if (active === hand || interaction.hasHandGrab) interaction.updateHands(hand.handFrames(), now);
  else interaction.update(f?.cursor ?? null, pressStarted, now, f?.gesture ?? 'none', releaseStarted);
  view.render();

  hand.handFrames().forEach((handFrame, i) => {
    const cursorEl = handCursors[i];
    cursorEl.style.display = handFrame.cursor ? 'block' : 'none';
    if (handFrame.cursor) {
      cursorEl.style.transform = `translate(${handFrame.cursor.x * innerWidth}px, ${handFrame.cursor.y * innerHeight}px)`;
      cursorEl.classList.toggle('pressed', handFrame.pressed &&
        (!interaction.hasHandBlockGrab || interaction.isHandGrabbing(i)));
    }
  });

  $('hud-source').textContent = `Input: ${active === hand ? 'Hand' : 'Mouse'}`;
  $('hud-set').textContent = setStatus();
  const held = interaction.held;
  $('hud-held').textContent = buildingSet()
    ? setView.anchored
      ? 'Holding the next piece'
      : `Holding the first piece · set turned ${setView.turns * 90}°`
    : held
      ? `Holding ${held.type.replace('x', '×')} at ${held.rot}°`
      : 'Holding nothing';
  $('hud-message').textContent = interaction.message;
  $('hud-message').className = interaction.messageKind;
  const buildSide = hand.swapHands ? 'Left' : 'Right';
  const viewSide = hand.swapHands ? 'Right' : 'Left';
  $('hand-status').innerHTML =
    hand.status === 'running'
      ? `<span class="build">${buildSide}: ${describe(hand.gestures)}</span><br>` +
        `<span class="view">${viewSide}: ${describe(hand.viewGestures)}</span>`
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