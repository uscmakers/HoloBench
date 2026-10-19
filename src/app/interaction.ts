import { type BrickType, PALETTE, type Rotation, nextRotation } from '../model/bricks';
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
  private hoverEl: Element | null = null;

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

    if (button) {
      this.view.setGhost(null, this.color, false);
      if (pressStarted) this.runAction(button.dataset.action!, button.dataset.value);
      return;
    }

    const onBuild = !!cursor && el === this.view.renderer.domElement;
    const hit = onBuild && this.held ? this.view.pick(cursor!) : null;
    if (!this.held || !hit) {
      this.view.setGhost(null, this.color, false);
      if (pressStarted && onBuild && !this.held) this.flash('Pick a brick from the tray first', now);
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
        if (!this.held) this.flash('Pick a brick first, then rotate it', performance.now());
        else {
          this.held = { ...this.held, rot: nextRotation(this.held.rot) };
          if (this.held.type === '2x2') this.flash('2×2 is square, so it looks the same rotated', performance.now());
        }
        break;
      case 'view':
        this.view.turnView(Number(value));
        break;
      case 'undo':
        this.model.undo();
        break;
      case 'redo':
        this.model.redo();
        break;
      case 'empty':
        this.held = null;
        break;
    }
    this.syncTray();
  }

  /** Marks the selected brick type and color in the tray. */
  syncTray() {
    for (const el of document.querySelectorAll<HTMLElement>('[data-action="type"]')) {
      el.classList.toggle('selected', el.dataset.value === this.held?.type);
    }
    for (const el of document.querySelectorAll<HTMLElement>('[data-action="color"]')) {
      el.classList.toggle('selected', el.dataset.value === this.color);
    }
    for (const el of document.querySelectorAll<HTMLButtonElement>('[data-action="undo"]')) el.disabled = !this.model.canUndo;
    for (const el of document.querySelectorAll<HTMLButtonElement>('[data-action="redo"]')) el.disabled = !this.model.canRedo;
  }

  private setHover(el: Element | null) {
    if (el === this.hoverEl) return;
    this.hoverEl?.classList.remove('hover');
    el?.classList.add('hover');
    this.hoverEl = el;
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
