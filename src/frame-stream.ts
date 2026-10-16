import type { CDPSession } from 'playwright';
import { WebSocket } from 'ws';

export const STREAM_PROFILES = {
  economy: { fps: 4, quality: 50 },
  balanced: { fps: 8, quality: 70 },
  smooth: { fps: 15, quality: 80 },
} as const;
export type StreamProfile = keyof typeof STREAM_PROFILES;
type Target = { id: string; cdp: CDPSession };
type Frame = { tabId: string; sequence: number; data: Buffer };
type Viewer = { visible: boolean; pending?: number; sentAt: number };

/** Owns capture, duplicate suppression and one-frame-per-viewer flow control. */
export class FrameStream {
  private readonly viewers = new Map<WebSocket, Viewer>();
  private target?: Target;
  private latest?: Frame;
  private timer?: NodeJS.Timeout;
  private capturing = false;
  private closed = false;
  private profile: StreamProfile = 'balanced';
  private sequence = 0;
  private captured = 0;
  private transmitted = 0;
  private suppressed = 0;
  private bytesSent = 0;
  private failures = 0;
  private failed = false;
  private lastBroadcast = 0;

  constructor(private readonly onError: (error: unknown) => void) {}

  snapshot() {
    return { profile: this.profile, ...STREAM_PROFILES[this.profile], captured: this.captured,
      transmitted: this.transmitted, suppressed: this.suppressed, bytesSent: this.bytesSent,
      failures: this.failures, failed: this.failed,
      visibleViewers: [...this.viewers.values()].filter(viewer => viewer.visible).length };
  }
  select(target: Target | undefined) {
    if (this.target?.id === target?.id) return;
    this.target = target;
    this.latest = undefined;
    this.lastBroadcast = 0;
    // A previously decoded frame may still be acknowledged, but cannot block the new target.
    for (const viewer of this.viewers.values()) viewer.pending = undefined;
  }
  add(ws: WebSocket) {
    this.viewers.set(ws, { visible: true, sentAt: 0 });
    if (this.latest) this.send(ws, this.viewers.get(ws)!, this.latest);
    // A newly requested connection is an explicit attempt to restart a failed stream.
    this.failed = false;
    this.schedule();
  }
  remove(ws: WebSocket) { this.viewers.delete(ws); this.schedule(); }
  acknowledge(ws: WebSocket, sequence: number) {
    const viewer = this.viewers.get(ws);
    if (viewer?.pending === sequence) viewer.pending = undefined;
  }
  visible(ws: WebSocket, visible: boolean) {
    const viewer = this.viewers.get(ws);
    if (!viewer || viewer.visible === visible) return;
    viewer.visible = visible;
    viewer.pending = undefined;
    if (visible && this.latest) this.send(ws, viewer, this.latest);
    this.schedule();
  }
  configure(profile: StreamProfile) {
    this.profile = profile;
    this.latest = undefined;
    this.lastBroadcast = 0;
    this.schedule();
  }
  private schedule() {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.closed || this.failed || ![...this.viewers.values()].some(viewer => viewer.visible)) return;
    this.timer = setInterval(() => void this.capture(), 1000 / STREAM_PROFILES[this.profile].fps);
    this.timer.unref();
    void this.capture();
  }
  private send(ws: WebSocket, viewer: Viewer, frame: Frame) {
    if (!viewer.visible || viewer.pending !== undefined || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 500_000) return false;
    viewer.pending = frame.sequence;
    viewer.sentAt = Date.now();
    ws.send(JSON.stringify({ type: 'frame', tabId: frame.tabId, sequence: frame.sequence, bytes: frame.data.length }));
    ws.send(frame.data, { binary: true });
    this.bytesSent += frame.data.length;
    return true;
  }
  private async capture() {
    if (this.closed || this.failed || this.capturing || !this.target) return;
    const now = Date.now();
    const ready = [...this.viewers].filter(([ws, viewer]) => {
      if (viewer.visible && viewer.pending !== undefined && now - viewer.sentAt > 15_000) ws.close(4008, '画面处理超时，请重新连接');
      return viewer.visible && viewer.pending === undefined && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= 500_000;
    });
    if (!ready.length) return;
    this.capturing = true;
    const target = this.target;
    const profile = this.profile;
    try {
      const result = await target.cdp.send('Page.captureScreenshot', {
        format: 'jpeg', quality: STREAM_PROFILES[profile].quality, fromSurface: true, captureBeyondViewport: false,
      });
      if (this.closed || target !== this.target || profile !== this.profile) return;
      this.captured++;
      const data = Buffer.from(result.data, 'base64');
      if (this.latest?.data.equals(data) && now - this.lastBroadcast < 2000) {
        this.suppressed++;
        return;
      }
      const frame = { tabId: target.id, sequence: ++this.sequence, data };
      this.latest = frame;
      let sent = false;
      for (const [ws, viewer] of ready) sent = this.send(ws, viewer, frame) || sent;
      if (sent) { this.transmitted++; this.lastBroadcast = now; }
    } catch (error) {
      if (!this.closed && target === this.target) {
        this.failed = true;
        this.failures++;
        clearInterval(this.timer);
        this.timer = undefined;
        this.onError(error);
      }
    } finally { this.capturing = false; }
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.latest = undefined;
    this.viewers.clear();
  }
}
