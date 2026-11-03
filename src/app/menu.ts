export interface MenuItem {
  action: string;
  value?: string;
  /** Text or HTML for the button face. */
  label: string;
  title: string;
  /** Inner ring holds colors, outer ring shapes and actions. */
  ring: 'inner' | 'outer';
  swatch?: string;
}

const INNER_RADIUS = 88;
const OUTER_RADIUS = 172;
const MARGIN = OUTER_RADIUS + 48;

/**
 * A ring menu that opens around the cursor, so picking a brick or color is a short move
 * from where the hand already is instead of a trip to a tray. Its buttons carry
 * data-action like any other, so a pinch or click on one runs through Interaction.
 */
export class RadialMenu {
  readonly el = document.createElement('div');
  /** 'hand': held open by the open palm. 'toggle': opened from the keyboard, closed by a pick or Esc. */
  openedBy: 'hand' | 'toggle' | null = null;
  private x = 0;
  private y = 0;

  constructor(parent: HTMLElement) {
    this.el.id = 'radial-menu';
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  get open() {
    return this.openedBy !== null;
  }

  /** Opens centred on a viewport position (0..1), kept far enough from the edges to fit. */
  show(at: { x: number; y: number }, by: 'hand' | 'toggle', items: MenuItem[], center: string) {
    this.x = Math.min(Math.max(at.x * innerWidth, MARGIN), Math.max(innerWidth - MARGIN, MARGIN));
    this.y = Math.min(Math.max(at.y * innerHeight, MARGIN), Math.max(innerHeight - MARGIN, MARGIN));
    this.openedBy = by;
    this.el.hidden = false;
    this.render(items, center);
  }

  hide() {
    this.openedBy = null;
    this.el.hidden = true;
  }

  contains(el: Element | null) {
    return !!el && this.el.contains(el);
  }

  render(items: MenuItem[], center: string) {
    if (!this.open) return;
    this.el.style.left = `${this.x}px`;
    this.el.style.top = `${this.y}px`;
    const rings = { inner: items.filter((i) => i.ring === 'inner'), outer: items.filter((i) => i.ring === 'outer') };
    const buttons = (['inner', 'outer'] as const).flatMap((ring) =>
      rings[ring].map((item, i, all) => {
        // Evenly around the ring, starting at the top.
        const a = -Math.PI / 2 + (i / all.length) * Math.PI * 2;
        const r = ring === 'inner' ? INNER_RADIUS : OUTER_RADIUS;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `menu-item ${ring}${item.swatch ? ' swatch' : ''}`;
        b.dataset.action = item.action;
        if (item.value !== undefined) b.dataset.value = item.value;
        b.title = item.title;
        b.setAttribute('aria-label', item.title);
        b.innerHTML = item.label;
        if (item.swatch) b.style.backgroundColor = item.swatch;
        // `translate`, not `transform`, so the hover scale still applies.
        b.style.translate = `${Math.cos(a) * r}px ${Math.sin(a) * r}px`;
        return b;
      }),
    );
    const hub = document.createElement('div');
    hub.className = 'menu-hub';
    hub.innerHTML = center;
    this.el.replaceChildren(hub, ...buttons);
  }
}

/** A top-down picture of a brick's studs, w × d. */
export function studIcon(w: number, d: number) {
  const dots = '<i></i>'.repeat(w * d);
  return `<span class="studs" style="grid-template-columns: repeat(${d}, 1fr); width: ${d * 9}px">${dots}</span>`;
}
