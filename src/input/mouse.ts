import type { InputFrame, InputSource } from './types';

/** Mouse as a test input: pointer position is the cursor, left button is "pinch". */
export class MouseInput implements InputSource {
  readonly name = 'mouse';
  private state: InputFrame = { cursor: null, pressed: false, pressCount: 0, lastActive: 0 };

  constructor(target: Window = window) {
    target.addEventListener('pointermove', (e) => this.set(e, this.state.pressed));
    target.addEventListener('pointerdown', (e) => e.button === 0 && this.set(e, true));
    target.addEventListener('pointerup', (e) => e.button === 0 && this.set(e, false));
    target.addEventListener('blur', () => (this.state = { ...this.state, pressed: false }));
  }

  private set(e: PointerEvent, pressed: boolean) {
    this.state = {
      cursor: { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight },
      pressed,
      pressCount: this.state.pressCount + (pressed && !this.state.pressed ? 1 : 0),
      lastActive: performance.now(),
    };
  }

  frame(): InputFrame {
    return this.state;
  }
}
