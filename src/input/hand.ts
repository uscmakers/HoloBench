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

const MOVE_EPSILON = 0.003;

export type HandStatus = 'off' | 'loading' | 'running' | 'error';
export type HandEvent = 'cancel';

/**
 * Webcam hand tracking (MediaPipe). Either hand can orbit with a pinch, grasp controls or blocks,
 * and point at colors while the other hand holds a block. Both hands expose independent cursors.
 */
export class HandInput implements InputSource {
  readonly name = 'hand';
  status: HandStatus = 'off';
  error = '';
  zone: Zone = { ...DEFAULT_ZONE };
  /** Swap which hand builds (for left-handed users, or if the camera reports hands the other way round). */
  swapHands = false;
  /** First tracked hand's gesture detector. */
  readonly gestures = new GestureDetector();
  /** Second tracked hand's gesture detector. */
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
  private cursorVX = new OneEuroFilter();
  private cursorVY = new OneEuroFilter();
  private vs = new OneEuroFilter(1, 2);
  private bx = new OneEuroFilter();
  private by = new OneEuroFilter();
  private bs = new OneEuroFilter(1, 2);
  private viewDelta: ViewDelta = { dx: 0, dy: 0, zoom: 1 };
  private buildViewGrab = new ViewGrab();
  private state: InputFrame = { cursor: null, pressed: false, pressCount: 0, releaseCount: 0, gesture: 'none', lastActive: 0 };
  private viewState: InputFrame = { cursor: null, pressed: false, pressCount: 0, releaseCount: 0, gesture: 'none', lastActive: 0 };

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
      if (this.viewState.pressed) this.viewState.releaseCount++;
      this.viewState = { ...this.viewState, cursor: null, pressed: false, gesture: 'none' };
      this.viewGestures.update(null);
      this.viewGrab.update(null, false);
      this.vx.reset();
      this.vy.reset();
      this.vs.reset();
      this.cursorVX.reset();
      this.cursorVY.reset();
      return;
    }
    this.viewLandmarks = lm;
    this.viewRatio = pinchRatio(world);
    const previous = this.viewGestures.gesture;
    const started = this.viewGestures.update(world);
    if (started === 'fist') this.events.push('cancel');
    const pinched = this.viewGestures.gesture === 'pinch';
    const c = palmCenter(lm);
    const t = now / 1000;
    // Mirrored so that moving the hand to the user's right is positive.
    const p = { x: this.vx.filter(1 - c.x, t), y: this.vy.filter(c.y, t), size: this.vs.filter(palmSize(lm), t) };
    const d = this.viewGrab.update(p, pinched);
    this.viewDelta = { dx: this.viewDelta.dx + d.dx, dy: this.viewDelta.dy + d.dy, zoom: this.viewDelta.zoom * d.zoom };

    const anchor = this.viewGestures.gesture === 'point' ? lm[8] : c;
    const raw = mapToViewport(anchor, this.zone);
    const cursor = {
      x: this.cursorVX.filter(raw.x, t),
      y: this.cursorVY.filter(raw.y, t),
    };
    const wasGrasping = this.viewState.pressed;
    const pressed = this.viewGestures.gesture === 'grasp';
    const moved = !this.viewState.cursor || Math.hypot(cursor.x - this.viewState.cursor.x, cursor.y - this.viewState.cursor.y) > MOVE_EPSILON;
    this.viewState = {
      cursor,
      pressed,
      pressCount: this.viewState.pressCount + (pressed && !wasGrasping ? 1 : 0),
      releaseCount: this.viewState.releaseCount + (!pressed && wasGrasping ? 1 : 0),
      gesture: this.viewGestures.gesture,
      lastActive: moved || previous !== this.viewGestures.gesture ? now : this.viewState.lastActive,
    };
  }

  private updateBuild(lm: Point3[] | null, world: Point3[] | null, now: number) {
    if (!lm || !world) {
      this.landmarks = null;
      this.ratio = null;
      this.gestures.update(null);
      this.fx.reset();
      this.fy.reset();
      if (this.state.pressed) this.state.releaseCount++;
      this.state = { ...this.state, cursor: null, pressed: false, gesture: 'none' };
      this.buildViewGrab.update(null, false);
      return;
    }

    this.landmarks = lm;
    this.ratio = pinchRatio(world);
    const previous = this.gestures.gesture;
    const started = this.gestures.update(world);
    if (started === 'fist') this.events.push('cancel');
    const t = now / 1000;
    const center = palmCenter(lm);
    const anchor = this.gestures.gesture === 'point' ? lm[8] : center;
    const raw = mapToViewport(anchor, this.zone);
    const cursor = { x: this.fx.filter(raw.x, t), y: this.fy.filter(raw.y, t) };
    const wasGrasping = this.state.pressed;
    const pressed = this.gestures.gesture === 'grasp';
    const moved = !this.state.cursor || Math.hypot(cursor.x - this.state.cursor.x, cursor.y - this.state.cursor.y) > MOVE_EPSILON;
    this.state = {
      cursor,
      pressed,
      pressCount: this.state.pressCount + (pressed && !wasGrasping ? 1 : 0),
      releaseCount: this.state.releaseCount + (!pressed && wasGrasping ? 1 : 0),
      gesture: this.gestures.gesture,
      lastActive: moved || pressed !== wasGrasping || previous !== this.gestures.gesture ? now : this.state.lastActive,
    };

    // Either hand's pinch moves the camera; grasp and point are reserved for object/UI actions.
    const pinching = this.gestures.gesture === 'pinch';
    const p = {
      x: this.bx.filter(1 - center.x, t),
      y: this.by.filter(center.y, t),
      size: this.bs.filter(palmSize(lm), t),
    };
    const d = this.buildViewGrab.update(p, pinching);
    this.viewDelta = { dx: this.viewDelta.dx + d.dx, dy: this.viewDelta.dy + d.dy, zoom: this.viewDelta.zoom * d.zoom };
  }

  /** Independent frames with stable build/view hand identities. */
  handFrames(): readonly [InputFrame, InputFrame] {
    return [this.state, this.viewState];
  }

  frame(): InputFrame {
    if (!this.state.cursor) return this.viewState;
    if (!this.viewState.cursor) return this.state;
    if (this.state.pressed && this.viewState.pressed) return this.state.lastActive >= this.viewState.lastActive ? this.state : this.viewState;
    if (this.state.pressed) return this.state;
    if (this.viewState.pressed) return this.viewState;
    return this.state.lastActive >= this.viewState.lastActive ? this.state : this.viewState;
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