/**
 * AndroidMirrorStage — the Android half of {@link DeviceMirror}'s live stage.
 *
 * Where iOS embeds a serve-sim MJPEG `<img>` and streams continuous down/move/up
 * touches, Android has no such daemon: the Rust bridge streams screenrecord H.264
 * over a WebSocket, which {@link createAndroidMirror} decodes onto a `<canvas>` with
 * WebCodecs. Input is discrete (`adb shell input` can't stream a drag cheaply), so
 * a press→release becomes a tap or, if it moved, a swipe — synthesized here from the
 * pointer's start/end points and elapsed time.
 *
 * Self-contained: it owns the canvas, the decoder/socket handle, and its pointer
 * gestures. The parent ({@link DeviceMirror}) keeps the shared toolbar, build panel,
 * and launch detection.
 *
 * @module components/AndroidMirrorStage
 */

import { useEffect, useRef } from 'react';
import { createAndroidMirror, type AndroidMirrorHandle } from '../lib/androidMirror';

interface AndroidMirrorStageProps {
  /** The bridge WebSocket (`ws://127.0.0.1:<port>`) from the started session. */
  wsUrl: string;
  /** Surfaced on connection/decode failure — the parent routes this to auto-heal. */
  onError: (message: string) => void;
  /** Fired once when the first frame paints — the parent drops its spinner / refills
   *  the heal budget. Must be referentially stable, or the decoder reconnects. */
  onFirstFrame: () => void;
}

/** Below this normalized move distance a press→release is a tap, not a swipe. */
const TAP_SLOP = 0.02;

export function AndroidMirrorStage({ wsUrl, onError, onFirstFrame }: AndroidMirrorStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<AndroidMirrorHandle | null>(null);
  const downRef = useRef<{ x: number; y: number; t: number } | null>(null);

  // Connect the decoder once per wsUrl. A new session (Restart / heal) changes the
  // URL and re-runs this; onError/onFirstFrame are stable (parent useCallback) so a
  // healthy stream doesn't churn. Unmount closes the socket + decoder.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = createAndroidMirror({ wsUrl, canvas, onError, onFirstFrame });
    handleRef.current = handle;
    return () => {
      handle.close();
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, [wsUrl, onError, onFirstFrame]);

  const norm = (e: React.PointerEvent): { x: number; y: number } | null => {
    const el = canvasRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const p = norm(e);
    if (!p) return;
    downRef.current = { ...p, t: e.timeStamp };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const start = downRef.current;
    downRef.current = null;
    const handle = handleRef.current;
    if (!start || !handle) return;
    const p = norm(e);
    if (!p) return;
    const moved = Math.hypot(p.x - start.x, p.y - start.y);
    if (moved < TAP_SLOP) {
      handle.sendTap(start.x, start.y);
    } else {
      // Match the gesture's real duration so a flick scrolls and a slow drag drags.
      const ms = Math.max(50, Math.min(800, Math.round(e.timeStamp - start.t)));
      handle.sendSwipe(start.x, start.y, p.x, p.y, ms);
    }
  };

  return (
    <canvas
      ref={canvasRef}
      className="device-mirror-screen"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        downRef.current = null;
      }}
    />
  );
}
