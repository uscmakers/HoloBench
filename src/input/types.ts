/** One sample from any input device, in a device-independent form. */
export interface InputFrame {
  /** Cursor in viewport coordinates, 0..1 from the top-left. Null when the device has no position (hand lost). */
  cursor: { x: number; y: number } | null;
  /** Pinch held, mouse button held, glove grab closed... */
  pressed: boolean;
  /** Increments on every press, so a press shorter than one animation frame is not missed. */
  pressCount: number;
  /** Last time (ms) the user did something with this device. Used to pick the active device. */
  lastActive: number;
}

export interface InputSource {
  readonly name: string;
  frame(): InputFrame;
}
