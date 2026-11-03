import { BRICK_DEFS, type BrickType, PALETTE, type Rotation, nextRotation } from '../model/bricks';
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
 * What a "press" means depends on what's under the cursor: a tray button runs its action,
 * the build places the held brick. Every input device goes through here the same way.
 */
export class Interaction {
  held: Held | null = null;
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

  /** cursor: viewport 0..1 (null = no cursor). pressStarted: a pinch or click began this frame. */
  update(cursor: { x: number; y: number } | null, pressStarted: boolean, now: number) {
    if (now > this.messageUntil) this.message = '';
    const el = cursor ? document.elementFromPoint(cursor.x * innerWidth, cursor.y * innerHeight) : null;
    const button = el?.closest<HTMLElement>('[data-action]') ?? null;
    this.setHover(button);

    this.dwell(button, pressStarted, now);
    if (button) {
      this.buildAreaOverride(null, false);
      this.view.setGhost(null, this.color, false);
      if (pressStarted) this.runAction(button.dataset.action!, button.dataset.value);
      return;
    }

    const onBuild = !!cursor && el === this.view.renderer.domElement;
    if (this.buildAreaOverride(onBuild ? cursor : null, onBuild && pressStarted)) {
      this.view.setGhost(null, this.color, false);
      return;
    }
    const hit = onBuild && this.held ? this.view.pick(cursor!) : null;
    if (!this.held || !hit) {
      this.view.setGhost(null, this.color, false);
      if (pressStarted && onBuild && !this.held) this.flash('Show your left palm (or press Space) to pick a brick', now);
      return;
    }

    const target = placementAt(this.model, hit.gx, hit.gz, this.held.type, this.held.rot);
    const check = this.model.validate(target);
    this.view.setGhost(target, this.color, check.ok);
    if (pressStarted) {
      const result = this.model.add(target, this.color);
      if (!result.ok) this.flash(REASON_TEXT[result.reason], now);
    }
  }

  runAction(action: string, value?: string) {
    switch (action) {
      case 'type':
        this.held = { type: value as BrickType, rot: this.held?.rot ?? 0 };
        break;
      case 'color':
        if (value) this.color = value;
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
        break;
      default:
        this.extraAction(action, value);
    }
    this.syncTray();
    this.onAction(action, value);
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
