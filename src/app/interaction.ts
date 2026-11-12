import type { InputFrame } from '../input/types';
import { BRICK_DEFS, type BrickType, PALETTE, isColor, type Rotation, nextRotation } from '../model/bricks';
import type { Brick } from '../model/bricks';
import type { BuildModel, Reason } from '../model/build';
import type { BuildView } from '../scene/view';
import { placementAt } from './target';

const REASON_TEXT: Record<Reason, string> = {
  out_of_bounds: 'Off the baseplate',
  collision: 'Something is in the way',
  unsupported: 'Nothing to attach to',
  would_disconnect: 'Other bricks depend on that one',
  not_found: 'Brick not found',
};

export interface Held {
  type: BrickType;
  rot: Rotation;
}

/**
 * Coordinates palette picks, two-hand recoloring, grasp/release placement, and stack moves.
 */
export class Interaction {
  held: Held | null = null;
  private paletteDrop = false;
  private movingStack: { id: string; bricks: Brick[] } | null = null;
  color: string = PALETTE[0];
  message = '';
  messageKind: 'info' | 'error' = 'error';
  private messageUntil = 0;
  private hoverEl: HTMLElement | null = null;
  /** Handles tray actions the editor doesn't know (e.g. LDraw set steps). Returns true if it handled one. */
  extraAction: (action: string, value?: string) => boolean = () => false;
  /**
   * Gets first say over the build area (e.g. placing LDraw set pieces). Returns true to take over
   * from free-brick placing. Called with a null cursor when the cursor is over the tray or gone.
   */
  buildAreaOverride: (cursor: { x: number; y: number } | null, pressStarted: boolean) => boolean = () => false;
  /** Replaces the editor's undo/redo state for the tray buttons while something else owns undo (null = editor's). */
  historyOverride: () => { canUndo: boolean; canRedo: boolean } | null = () => null;
  /** Called after every action, e.g. to close or refresh a menu. */
  onAction: (action: string, value?: string) => void = () => {};
  /** Holding the cursor on a button this long picks it, where `canDwell` allows (e.g. menus, by hand). */
  dwellMs = 700;
  canDwell: (el: HTMLElement) => boolean = () => false;
  // Keyed by action and value, not element, so a menu redrawn under the cursor doesn't restart or repeat a pick.
  private dwellKey = '';
  private dwellSince = 0;
  private dwellDone = '';

  constructor(
    private model: BuildModel,
    private view: BuildView,
  ) {}

  private handOwner: number | null = null;
  private handPresses = [0, 0];
  private recoloredGrab = false;

  get hasHandGrab(): boolean {
    return this.handOwner !== null;
  }

  /** Keep a grab attached to its hand while the other hand points at colors. */
  updateHands(frames: readonly [InputFrame, InputFrame], now: number) {
    const presses = frames.map((f, i) => !!f.cursor && f.pressed && f.pressCount !== this.handPresses[i]);
    this.handPresses = frames.map((f) => f.pressCount);
    if (this.handOwner === null) {
      const owner = presses.findIndex(Boolean);
      if (owner >= 0) this.handOwner = owner;
    }
    const owner = this.handOwner;
    if (owner === null) {
      const f = [...frames].filter((f) => f.cursor).sort((a, b) => b.lastActive - a.lastActive)[0];
      this.update(f?.cursor ?? null, false, now, f?.gesture ?? 'none');
      return;
    }
    const holding = frames[owner];
    const other = frames[1 - owner];
    const released = !holding.cursor || !holding.pressed;
    if (presses[owner]) this.update(holding.cursor, true, now, holding.gesture);

    if (!released && this.movingStack && other.cursor && other.gesture === 'point') {
      const button = document.elementFromPoint(other.cursor.x * innerWidth, other.cursor.y * innerHeight)
        ?.closest<HTMLElement>('[data-action="color"]') ?? null;
      this.setHover(button);
      const color = button?.dataset.value;
      if (color && isColor(color)) {
        if (this.model.setColor(this.movingStack.id, color)) this.notify('Brick recolored · release your grasp to finish');
        this.color = color;
        this.recoloredGrab = true;
        this.view.setHidden(null);
        this.view.setGhost(null, color, false);
        this.view.setGhostStack([], true);
        this.syncTray();
      }
    }
    if (this.recoloredGrab) {
      // Recolor in place: releasing must not also commit the pending stack move.
      if (released) this.cancelMove();
    } else if (!presses[owner]) {
      this.update(holding.cursor, false, now, holding.gesture, released);
    }
    if (released) {
      this.handOwner = null;
      this.recoloredGrab = false;
      this.setHover(null);
    }
  }

  /** cursor: viewport 0..1 (null = no cursor). pressStarted: a pinch or click began this frame. */
  update(cursor: { x: number; y: number } | null, pressStarted: boolean, now: number, gesture = 'none', releaseStarted = false) {
    if (now > this.messageUntil) this.message = '';
    const openRelease = releaseStarted && (gesture === 'open' || gesture === 'palm');
    const el = cursor ? document.elementFromPoint(cursor.x * innerWidth, cursor.y * innerHeight) : null;
    const button = el?.closest<HTMLElement>('[data-action]') ?? null;
    this.setHover(button);

    this.dwell(button, pressStarted, now);
    if (button) {
      this.buildAreaOverride(null, false);
      this.view.setGhost(null, this.color, false);
      this.view.setGhostStack([], true);
      // A held new brick can still be rotated or recolored from the top controls.
      // Releasing over these controls edits the held brick; releasing over the board places it.
      if (this.paletteDrop && releaseStarted && ['rotate', 'color'].includes(button.dataset.action!)) {
        this.runAction(button.dataset.action!, button.dataset.value);
        return;
      }
      if (releaseStarted && this.movingStack) this.cancelMove();
      if (releaseStarted && this.paletteDrop) {
        this.held = null;
        this.paletteDrop = false;
      }
      if (pressStarted) {
        if (button.dataset.action === 'type' && gesture === 'grasp') this.paletteDrop = true;
        this.runAction(button.dataset.action!, button.dataset.value);
      }
      return;
    }

    const onBuild = !!cursor && el === this.view.renderer.domElement;
    if (this.paletteDrop && openRelease && !onBuild) {
      this.held = null;
      this.paletteDrop = false;
      this.notify('Cancelled brick placement · release over the platform to place it');
    }
    if (this.movingStack) {
      if (!onBuild || !cursor) {
        this.view.setGhostStack([], true);
        if (releaseStarted) this.cancelMove();
        return;
      }

      const root = this.model.getBrick(this.movingStack.id);
      const hit = this.view.pick(cursor);
      if (!root || !hit) {
        this.view.setGhostStack([], true);
        if (releaseStarted) this.cancelMove();
        return;
      }

      const ids = new Set(this.movingStack.bricks.map((brick) => brick.id));
      const target = placementAt(this.model, hit.gx, hit.gz, root.type, root.rot, ids);
      const preview = this.model.previewMoveStack(root.id, target);
      if (!preview) return;
      this.view.setGhostStack(preview.bricks.map((brick, i) => ({
        id: brick.id, placement: preview.placements[i], color: brick.color,
      })), preview.check.ok);

      if (openRelease) {
        const result = this.model.moveStack(root.id, target);
        if (!result.ok) {
          this.flash(REASON_TEXT[result.reason], now);
          this.cancelMove();
          return;
        }
        this.cancelMove();
        this.notify('Moved the block and the blocks above it');
      } else if (releaseStarted) {
        this.cancelMove();
      }
      return;
    }

    // Grasping a placed block picks it and the blocks resting on it up as a unit.
    if (onBuild && pressStarted && gesture === 'grasp') {
      const id = this.view.brickAt(cursor!);
      if (id) {
        const bricks = this.model.stackAbove(id);
        this.movingStack = { id, bricks };
        this.view.setHidden(bricks.map((brick) => brick.id));
        this.notify(`Picked up ${bricks.length} block${bricks.length === 1 ? '' : 's'} · point at a color with your other hand, or open to move`);
        return;
      }
    }

    if (this.buildAreaOverride(onBuild ? cursor : null, onBuild && pressStarted)) {
      this.view.setGhost(null, this.color, false);
      this.view.setGhostStack([], true);
      return;
    }
    const hit = onBuild && this.held ? this.view.pick(cursor!) : null;
    if (!this.held || !hit) {
      this.view.setGhost(null, this.color, false);
      this.view.setGhostStack([], true);
      if (openRelease && this.paletteDrop) {
        this.held = null;
        this.paletteDrop = false;
        this.syncTray();
      }
      if (pressStarted && onBuild && !this.held) this.flash('Show your left palm (or press Space) to pick a brick', now);
      return;
    }

    const target = placementAt(this.model, hit.gx, hit.gz, this.held.type, this.held.rot);
    const check = this.model.validate(target);
    this.view.setGhost(target, this.color, check.ok);
    this.view.setGhostStack([], true);
    if ((this.paletteDrop && openRelease) || (!this.paletteDrop && pressStarted)) {
      const result = this.model.add(target, this.color);
      if (!result.ok) {
        this.flash(REASON_TEXT[result.reason], now);
        if (this.paletteDrop) {
          this.held = null;
          this.paletteDrop = false;
          this.syncTray();
        }
      }
      else if (this.paletteDrop) {
        this.held = null;
        this.paletteDrop = false;
        this.syncTray();
      }
    }
  }

  runAction(action: string, value?: string) {
    switch (action) {
      case 'type':
        this.held = { type: value as BrickType, rot: this.held?.rot ?? 0 };
        break;
      case 'color':
        if (value) {
          this.color = value;
        }
        break;
      case 'rotate':
        if (this.extraAction('rotate')) break;
        if (!this.held) this.flash('Pick a brick first, then rotate it', performance.now());
        else {
          this.held = { ...this.held, rot: nextRotation(this.held.rot) };
          const { width, depth } = BRICK_DEFS[this.held.type];
          if (width === depth) this.flash('A square brick looks the same rotated', performance.now());
        }
        break;
      case 'view':
        this.view.turnView(Number(value));
        break;
      case 'undo':
        if (!this.extraAction('undo')) this.model.undo();
        break;
      case 'redo':
        if (!this.extraAction('redo')) this.model.redo();
        break;
      case 'empty':
        this.held = null;
        this.paletteDrop = false;
        this.cancelMove();
        break;
      default:
        this.extraAction(action, value);
    }
    this.syncTray();
    this.onAction(action, value);
  }

  cancelMove() {
    this.recoloredGrab = false;
    this.movingStack = null;
    this.view.setHidden(null);
    this.view.setGhostStack([], true);
  }

  /** Marks the selected brick type and color in the tray. */
  syncTray() {
    for (const el of document.querySelectorAll<HTMLElement>('[data-action="type"]')) {
      el.classList.toggle('selected', el.dataset.value === this.held?.type);
    }
    for (const el of document.querySelectorAll<HTMLElement>('[data-action="color"]')) {
      el.classList.toggle('selected', el.dataset.value === this.color);
    }
    const history = this.historyOverride() ?? this.model;
    for (const el of document.querySelectorAll<HTMLButtonElement>('[data-action="undo"]')) el.disabled = !history.canUndo;
    for (const el of document.querySelectorAll<HTMLButtonElement>('[data-action="redo"]')) el.disabled = !history.canRedo;
  }

  /** Fills the hovered button's --dwell (0..1) and picks it when full. A pinch counts as the pick. */
  private dwell(el: HTMLElement | null, pressStarted: boolean, now: number) {
    const key = el && this.canDwell(el) ? `${el.dataset.action}|${el.dataset.value ?? ''}` : '';
    if (key !== this.dwellKey) {
      this.dwellKey = key;
      this.dwellSince = now;
      this.dwellDone = '';
    }
    if (pressStarted) this.dwellDone = key;
    if (!el || !key) return;
    const progress = key === this.dwellDone ? 0 : Math.min((now - this.dwellSince) / this.dwellMs, 1);
    el.style.setProperty('--dwell', String(progress));
    if (progress < 1) return;
    this.dwellDone = key;
    el.style.setProperty('--dwell', '0');
    this.runAction(el.dataset.action!, el.dataset.value);
  }

  private setHover(el: HTMLElement | null) {
    if (el === this.hoverEl) return;
    this.hoverEl?.style.removeProperty('--dwell');
    this.hoverEl?.classList.remove('hover');
    el?.classList.add('hover');
    this.hoverEl = el;
  }

  /** Error-style feedback (something didn't work). */
  warn(text: string) {
    this.flash(text, performance.now());
  }

  /** Neutral feedback, e.g. confirming a gesture was recognised. */
  notify(text: string) {
    this.flash(text, performance.now());
    this.messageKind = 'info';
  }

  private flash(text: string, now: number) {
    this.messageKind = 'error';
    this.message = text;
    this.messageUntil = now + 1500;
  }
}