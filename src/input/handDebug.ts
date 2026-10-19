import type { HandInput } from './hand';

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

/** Mirrored camera preview with the tracked hand, the active zone and a pinch meter. */
export function drawHandDebug(canvas: HTMLCanvasElement, hand: HandInput) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  if (hand.video.readyState >= 2) {
    ctx.globalAlpha = 0.55;
    ctx.drawImage(hand.video, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  // Build hand in blue (green while pinched), view hand in orange (bright while turning).
  drawHand(ctx, hand.landmarks, hand.gestures.gesture === 'pinch' ? '#6effa8' : '#7fd4ff', w, h);
  drawHand(ctx, hand.viewLandmarks, hand.viewGrab.grabbing ? '#ffd24f' : '#ff9a3c', w, h);
  ctx.restore();

  // Zone is defined in mirrored (what-you-see) coordinates.
  const z = hand.zone;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(z.x0 * w, z.y0 * h, (z.x1 - z.x0) * w, (z.y1 - z.y0) * h);
  ctx.setLineDash([]);

  // Pinch meter: bar = current ratio, ticks = close/open thresholds.
  const max = 1;
  const bar = (v: number) => Math.min(v / max, 1) * (w - 16);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(8, h - 20, w - 16, 12);
  if (hand.ratio !== null) {
    ctx.fillStyle = hand.gestures.gesture === 'pinch' ? '#6effa8' : '#7fd4ff';
    ctx.fillRect(8, h - 20, bar(hand.ratio), 12);
  }
  ctx.fillStyle = '#ffffff';
  for (const t of [hand.gestures.thresholds.pinchClose, hand.gestures.thresholds.pinchOpen]) ctx.fillRect(8 + bar(t) - 1, h - 23, 2, 18);
}

function drawHand(ctx: CanvasRenderingContext2D, lm: Array<{ x: number; y: number }> | null, color: string, w: number, h: number) {
  if (!lm) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (const [a, b] of BONES) {
    ctx.beginPath();
    ctx.moveTo(lm[a].x * w, lm[a].y * h);
    ctx.lineTo(lm[b].x * w, lm[b].y * h);
    ctx.stroke();
  }
  ctx.fillStyle = '#ffffff';
  for (const i of [4, 8]) {
    ctx.beginPath();
    ctx.arc(lm[i].x * w, lm[i].y * h, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}
