import type { InputFrame } from '../input/types';
import { BRICK_DEFS, type BrickType, PALETTE, isColor, type Rotation, nextRotation, footprintSize } from '../model/bricks';
import type { Brick, Placement } from '../model/bricks';
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

interface HandGrab {
  id: string;
  ids: string[];
  recolored: boolean;
  preview: ReturnType<BuildModel['previewMoveStack']>;
}

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

  // UI/palette interactions retain their existing single-hand behavior.
  private handOwner: number | null = null;
  private handPresses = [0, 0];
  private handGrabs: [HandGrab | null, HandGrab | null] = [null, null];
  private blockOwners = new Map<string, number>();

  get hasHandGrab(): boolean {
    return this.handOwner !== null || this.hasHandBlockGrab;
  }

  get hasHandBlockGrab(): boolean {
    return this.handGrabs.some(Boolean);
  }

  isHandGrabbing(hand: number): boolean {
    return !!this.handGrabs[hand] || this.handOwner === hand;
  }

  /** Each hand carries its own stack; every member is reserved until that hand releases. */
  updateHands(frames: readonly [InputFrame, InputFrame], now: number) {
    if (now > this.messageUntil) this.message = '';
    const presses = frames.map((f, i) => !!f.cursor && f.pressed && f.pressCount !== this.handPresses[i]);
    this.handPresses = frames.map((f) => f.pressCount);
    let handled = this.hasHandBlockGrab;

    // Acquire before processing releases: an occupied block cannot be handed off in the same frame.
    if (this.handOwner === null) frames.forEach((f, hand) => {
      if (!presses[hand] || this.handGrabs[hand] || !f.cursor) return;
      const el = document.elementFromPoint(f.cursor.x * innerWidth, f.cursor.y * innerHeight);
      if (el !== this.view.renderer.domElement) return;
      const id = this.view.brickAt(f.cursor);
      if (!id) return;
      handled = true;
      const bricks = this.model.stackAbove(id);
      if (!bricks.length) return;
      if (bricks.some((b) => this.blockOwners.has(b.id))) {
        this.notify('That block or stack is already held by your other hand');
        return;
      }
      const ids = bricks.map((b) => b.id);
      ids.forEach((id) => this.blockOwners.set(id, hand));
      this.handGrabs[hand] = { id, ids, recolored: false, preview: null };
      this.notify('Block grabbed · open this hand to place, or point at a color with the other hand');
    });

    if (handled) {
      frames.forEach((f, hand) => {
        const grab = this.handGrabs[hand];
        if (!grab) return;
        if (!grab.ids.every((id) => this.model.getBrick(id))) {
          this.releaseHandGrab(hand);
          return;
        }
        const released = !f.cursor || !f.pressed;
        const other = frames[1 - hand];
        if (!released && other.cursor && other.gesture === 'point' && !this.handGrabs[1 - hand]) {
          const chip = document.elementFromPoint(other.cursor.x * innerWidth, other.cursor.y * innerHeight)
            ?.closest<HTMLElement>('[data-action="color"]') ?? null;
          this.setHover(chip);
          const color = chip?.dataset.value;
          if (color && isColor(color)) {
            if (this.model.setColor(grab.id, color)) this.notify('Brick recolored · release your grasp to finish');
            this.color = color;
            grab.recolored = true;
            this.syncTray();
          }
        }
        grab.preview = null;
        const onBuild = f.cursor && document.elementFromPoint(f.cursor.x * innerWidth, f.cursor.y * innerHeight)
          === this.view.renderer.domElement;
        const root = this.model.getBrick(grab.id)!;
        const hit = onBuild && !grab.recolored ? this.view.pick(f.cursor!) : null;
        const target = hit ? placementAt(this.model, hit.gx, hit.gz, root.type, root.rot, new Set(grab.ids)) : null;
        const preview = target ? this.model.previewMoveStack(grab.id, target, grab.ids) : null;
        // Do not place onto the original, hidden position of another carried stack.
        const touchesOtherGrab = preview?.placements.some((p) => {
          const a = footprintSize(p.type, p.rot);
          return [...this.blockOwners].some(([id, owner]) => {
            if (owner === hand) return false;
            const b = this.model.getBrick(id);
            if (!b) return false;
            const size = footprintSize(b.type, b.rot);
            return p.x < b.x + size.w && b.x < p.x + a.w &&
              p.z < b.z + size.d && b.z < p.z + a.d &&
              p.y <= b.y + BRICK_DEFS[b.type].height && b.y <= p.y + BRICK_DEFS[p.type].height;
          });
        });
        if (preview && touchesOtherGrab) preview.check = { ok: false, reason: 'collision' };
        grab.preview = preview;
        if (released) {
          if (f.cursor && (f.gesture === 'open' || f.gesture === 'palm') && !grab.recolored && target && preview) {
            const result = preview.check.ok ? this.model.moveStack(grab.id, target, grab.ids) : preview.check;
            if (!result.ok) this.flash(REASON_TEXT[result.reason], now);
          }
          this.releaseHandGrab(hand);
        }
      });
      this.renderHandGrabs();
      if (!this.hasHandBlockGrab) this.setHover(null);
      return;
    }

    // Existing tray and new-brick placement flow, when no placed blocks are carried.
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
    const f = frames[owner];
    const released = !f.cursor || !f.pressed;
    this.update(f.cursor, presses[owner], now, f.gesture, released);
    if (released) this.handOwner = null;
  }

  private releaseHandGrab(hand: number) {
    this.handGrabs[hand]?.ids.forEach((id) => this.blockOwners.delete(id));
    this.handGrabs[hand] = null;
  }

  private renderHandGrabs() {
    const hidden: string[] = [];
    const ghosts: Array<{ id: string; placement: Placement; color: string; valid: boolean }> = [];
    for (const grab of this.handGrabs) {
      if (!grab || grab.recolored) continue;
      hidden.push(...grab.ids);
      const preview = grab.preview;
      if (preview) preview.bricks.forEach((b, i) => ghosts.push({
        id: b.id, placement: preview.placements[i], color: b.color, valid: preview.check.ok,
      }));
    }
    this.view.setHidden(hidden.length ? hidden : null);
    this.view.setGhost(null, this.color, false);
    this.view.setGhostStack(ghosts, true);
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
    this.handGrabs = [null, null];
    this.blockOwners.clear();
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