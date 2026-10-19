import { HandInput } from './input/hand';
import type { GestureDetector } from './input/gestures';
import { drawHandDebug } from './input/handDebug';
import { MouseInput } from './input/mouse';
import type { InputSource } from './input/types';
import { BuildModel } from './model/build';
import { PALETTE } from './model/bricks';
import { BuildView } from './scene/view';
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
  else if (e.key === '1') interaction.runAction('type', '2x2');
  else if (e.key === '2') interaction.runAction('type', '2x4');
});

$('hand-start').addEventListener('click', async () => {
  await hand.start();
  $('hand-start').style.display = hand.status === 'running' ? 'none' : '';
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
    if (ev === 'rotate') interaction.runAction('rotate');
    else if (ev === 'cancel' && interaction.held) {
      interaction.runAction('empty');
      interaction.notify('✊ Cancelled: hand is empty');
    } else if (ev === 'undo') {
      interaction.runAction('undo');
      interaction.notify('↶ Undo');
    } else if (ev === 'resetView') {
      view.resetView();
      interaction.notify('View reset');
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
  const held = interaction.held;
  $('hud-held').textContent = held ? `Holding ${held.type} at ${held.rot}°` : 'Holding nothing';
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
Object.assign(window, { model, view, hand, interaction });
