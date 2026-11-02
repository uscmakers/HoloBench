import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { OneEuroFilter } from './oneEuro';
import { GestureDetector } from './gestures';
import {
  DEFAULT_ZONE,
  type Point3,
  type ViewDelta,
  ViewGrab,
  type Zone,
  assignRoles,
  mapToViewport,
  palmCenter,
  palmSize,
  pinchRatio,
} from './handMath';
import type { InputFrame, InputSource } from './types';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// The cursor is held still around pinch changes, because closing and opening the fingers drags the palm a little.
const FREEZE_LOOKBACK_MS = 100;
const FREEZE_AFTER_RELEASE_MS = 150;
const MOVE_EPSILON = 0.003;

export type HandStatus = 'off' | 'loading' | 'running' | 'error';
export type HandEvent = 'cancel' | 'undo';

/**
 * Webcam hand tracking (MediaPipe) with two roles:
 * - build hand (right by default): palm position is the cursor, pinch is "pressed". This is the InputSource.
 * - view hand (left by default): pinch and drag to turn/tilt the view, push/pull while pinched to zoom.
 */
export class HandInput implements InputSource {
  readonly name = 'hand';
  status: HandStatus = 'off';
  error = '';
  zone: Zone = { ...DEFAULT_ZONE };
  /** Swap which hand builds (for left-handed users, or if the camera reports hands the other way round). */
  swapHands = false;
  /** Build hand: pinch = press, middle pinch = rotate brick, fist = cancel. */
  readonly gestures = new GestureDetector();
  /** View hand: pinch-drag = turn/tilt/zoom, middle pinch = undo, fist = reset view. */
  readonly viewGestures = new GestureDetector();
  /** One-shot gesture actions not yet handled by the app. */
  events: HandEvent[] = [];
  readonly viewGrab = new ViewGrab();
  readonly video = document.createElement('video');

  /** Latest raw data, for the debug view. */
  landmarks: Point3[] | null = null;
  ratio: number | null = null;
  viewLandmarks: Point3[] | null = null;
  viewRatio: number | null = null;

  private landmarker: HandLandmarker | null = null;
  private lastVideoTime = -1;
  private fx = new OneEuroFilter();
  private fy = new OneEuroFilter();
  private vx = new OneEuroFilter();
  private vy = new OneEuroFilter();
  private vs = new OneEuroFilter(1, 2);
  private viewDelta: ViewDelta = { dx: 0, dy: 0, zoom: 1 };
  private history: Array<{ t: number; x: number; y: number }> = [];
  private frozen: { x: number; y: number } | null = null;
  private releasedAt = 0;
  private state: InputFrame = { cursor: null, pressed: false, pressCount: 0, lastActive: 0 };

  /** Camera to use; remembered across reloads. Empty = browser default. */
  deviceId = loadCameraChoice();

  /** Video inputs with labels (labels are only filled in after camera permission is granted). */
  static async listCameras(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  /** Switches to another camera without reloading the hand model. */
  async useCamera(deviceId: string) {
    this.deviceId = deviceId;
    try {
      localStorage.setItem(CAMERA_KEY, deviceId);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this page only.
    }
    if (this.status !== 'running') return;
    (this.video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = await navigator.mediaDevices.getUserMedia(this.constraints());
    await this.video.play();
  }

  private constraints(): MediaStreamConstraints {
    const video: MediaTrackConstraints = { width: 640, height: 480 };
    if (this.deviceId) video.deviceId = { exact: this.deviceId };
    else video.facingMode = 'user';
    return { video, audio: false };
  }

  async start() {
    if (this.status === 'loading' || this.status === 'running') return;
    this.status = 'loading';
    try {
      // Some embedded browsers never answer the permission request; don't wait forever.
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia(this.constraints()).catch((e) => {
          // A remembered camera that was unplugged: fall back to the default one.
          if (this.deviceId && e?.name === 'OverconstrainedError') {
            this.deviceId = '';
            return navigator.mediaDevices.getUserMedia(this.constraints());
          }
          throw e;
        }),
        15000,
        'No camera permission answer. Open this page in Chrome and allow the camera.',
      );
      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await this.video.play();
      const fileset = await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}mediapipe`);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      this.status = 'running';
    } catch (e) {
      this.status = 'error';
      const name = e instanceof Error ? e.name : '';
      this.error =
        name === 'NotAllowedError'
          ? 'Camera blocked. Open this page in Chrome and allow the camera (or re-enable it in site settings).'
          : name === 'NotFoundError'
            ? 'No camera found.'
            : name === 'NotReadableError'
              ? 'Camera is in use by another app (Zoom, FaceTime…). Close it and retry.'
              : e instanceof Error
                ? e.message
                : String(e);
    }
  }

  /** Runs detection if the camera has a new frame. Call once per animation frame. */
  update(now: number) {
    if (!this.landmarker || this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;
    const result = this.landmarker.detectForVideo(this.video, now);
    const labels = result.handedness.map((h) => h[0]?.categoryName);
    const xs = result.landmarks.map((lm) => palmCenter(lm).x);
    const roles = assignRoles(labels, xs, this.swapHands);
    const buildIdx = roles.indexOf('build');
    const viewIdx = roles.indexOf('view');
    this.updateBuild(buildIdx >= 0 ? result.landmarks[buildIdx] : null, buildIdx >= 0 ? result.worldLandmarks[buildIdx] : null, now);
    this.updateView(viewIdx >= 0 ? result.landmarks[viewIdx] : null, viewIdx >= 0 ? result.worldLandmarks[viewIdx] : null, now);
  }

  /** View-hand motion accumulated since the last call. */
  consumeViewDelta(): ViewDelta {
    const d = this.viewDelta;
    this.viewDelta = { dx: 0, dy: 0, zoom: 1 };
    return d;
  }

  private updateView(lm: Point3[] | null, world: Point3[] | null, now: number) {
    if (!lm || !world) {
      this.viewLandmarks = null;
      this.viewRatio = null;
      this.viewGestures.update(null);
      this.viewGrab.update(null, false);
      this.vx.reset();
      this.vy.reset();
      this.vs.reset();
      return;
    }
    this.viewLandmarks = lm;
    this.viewRatio = pinchRatio(world);
    const started = this.viewGestures.update(world);
    // Middle-finger pinch is not used: it was unreliable on camera.
    if (started === 'fist') this.events.push('undo');
    const pinched = this.viewGestures.gesture === 'pinch';
    const c = palmCenter(lm);
    const t = now / 1000;
    // Mirrored so that moving the hand to the user's right is positive.
    const p = { x: this.vx.filter(1 - c.x, t), y: this.vy.filter(c.y, t), size: this.vs.filter(palmSize(lm), t) };
    const d = this.viewGrab.update(p, pinched);
    this.viewDelta = { dx: this.viewDelta.dx + d.dx, dy: this.viewDelta.dy + d.dy, zoom: this.viewDelta.zoom * d.zoom };
  }

  private updateBuild(lm: Point3[] | null, world: Point3[] | null, now: number) {
    if (!lm || !world) {
      this.landmarks = null;
      this.ratio = null;
      this.gestures.update(null);
      this.fx.reset();
      this.fy.reset();
      this.history = [];
      this.frozen = null;
      this.state = { ...this.state, cursor: null, pressed: false };
      return;
    }

    this.landmarks = lm;
    this.ratio = pinchRatio(world);
    const raw = mapToViewport(palmCenter(lm), this.zone);
    const smooth = { x: this.fx.filter(raw.x, now / 1000), y: this.fy.filter(raw.y, now / 1000) };
    this.history.push({ t: now, ...smooth });
    while (this.history.length && now - this.history[0].t > 500) this.history.shift();

    const wasPressed = this.state.pressed;
    const started = this.gestures.update(world);
    if (started === 'fist') this.events.push('cancel');
    const pressed = this.gestures.gesture === 'pinch';
    if (pressed && !wasPressed) {
      const before = this.history.find((h) => now - h.t <= FREEZE_LOOKBACK_MS) ?? smooth;
      this.frozen = { x: before.x, y: before.y };
    }
    if (!pressed && wasPressed) this.releasedAt = now;
    if (!pressed && this.frozen && now - this.releasedAt > FREEZE_AFTER_RELEASE_MS) this.frozen = null;

    const cursor = this.frozen ?? smooth;
    const prev = this.state.cursor;
    const moved = !prev || Math.hypot(cursor.x - prev.x, cursor.y - prev.y) > MOVE_EPSILON;
    this.state = {
      cursor,
      pressed,
      pressCount: this.state.pressCount + (pressed && !wasPressed ? 1 : 0),
      lastActive: moved || pressed !== wasPressed ? now : this.state.lastActive,
    };
  }

  frame(): InputFrame {
    return this.state;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

const CAMERA_KEY = 'holobench.camera';

function loadCameraChoice(): string {
  try {
    return localStorage.getItem(CAMERA_KEY) ?? '';
  } catch {
    return '';
  }
}
