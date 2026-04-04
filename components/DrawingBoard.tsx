"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import Pusher from "pusher-js";

/* ─── Types ─── */

interface Point {
  x: number;
  y: number;
}

type Stroke = {
  pts: number[];
  c?: string;
  w?: number;
  o?: number;
};

type Dot = {
  x: number;
  y: number;
  dot: true;
  c?: string;
  w?: number;
  o?: number;
};

type DrawOp = Stroke | Dot;

interface DrawEvent {
  ops: DrawOp[];
}

interface CursorEvent {
  id: string;
  x: number;
  y: number;
  color: string;
}

interface RemoteCursor {
  id: string;
  x: number;
  y: number;
  color: string;
  lastSeen: number;
}

/* ─── Constants ─── */

const LINE_WIDTH = 3;
const LINE_WIDTH_MIN = 1.2;   // thinnest (fast movement)
const LINE_WIDTH_MAX = 4.5;   // thickest (slow/still)
const WIDTH_LERP = 0.15;      // smoothing factor (0–1, lower = smoother transitions)
const CURSOR_SIZE = LINE_WIDTH * 2;
const SEND_INTERVAL = 100;
const MIN_OPACITY = 0.3;
const CURSOR_EXPIRE_MS = 5000;
const CURSOR_MOVE_THRESHOLD = 3;

function isDot(op: DrawOp): op is Dot {
  return "dot" in op;
}

function pressureToOpacity(p: number): number {
  return MIN_OPACITY + (1 - MIN_OPACITY) * p * p;
}

function forceToOpacity(f: number): number {
  const t = Math.max(0, Math.min(1, (f - 0.3) / 2.7));
  return MIN_OPACITY + (1 - MIN_OPACITY) * t * t;
}

/* ─── Smooth curve rendering ─── */

function drawSmoothPath(ctx: CanvasRenderingContext2D, pts: number[]) {
  const n = pts.length;
  if (n < 4) return;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  if (n === 4) {
    ctx.lineTo(pts[2], pts[3]);
  } else {
    ctx.lineTo((pts[0] + pts[2]) / 2, (pts[1] + pts[3]) / 2);
    for (let i = 2; i < n - 2; i += 2) {
      ctx.quadraticCurveTo(
        pts[i], pts[i + 1],
        (pts[i] + pts[i + 2]) / 2,
        (pts[i + 1] + pts[i + 3]) / 2
      );
    }
    ctx.lineTo(pts[n - 2], pts[n - 1]);
  }
  ctx.stroke();
}

/* ─── Component ─── */

export default function DrawingBoard({ room }: { room: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const isDrawing = useRef(false);
  const hasMoved = useRef(false);
  const activePoints = useRef<number[]>([]);
  const activeWidths = useRef<number[]>([]); // per-point width for variable thickness
  const activeOpacity = useRef(1);
  const batch = useRef<DrawOp[]>([]);
  const pendingPoints = useRef<number[]>([]);
  const pendingOpacity = useRef(1);
  const socketIdRef = useRef("");

  // Velocity-based width
  const lastMoveTime = useRef(0);
  const lastMovePos = useRef<Point>({ x: 0, y: 0 });
  const smoothedWidth = useRef(LINE_WIDTH);

  // Force Touch
  const currentForce = useRef(0);
  const hasForceTouch = useRef(false);

  // Cursor
  const cursorPos = useRef<Point>({ x: 0, y: 0 });
  const myColor = useRef("#2563eb");
  const myId = useRef(Math.random().toString(36).slice(2, 8));

  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(false);
  const [dark, setDark] = useState(false);
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([]);
  const [localCursor, setLocalCursor] = useState<Point | null>(null);
  const [cursorVisible, setCursorVisible] = useState(false);

  const inkColor = dark ? "#d5c4a1" : "#000000";
  const cursorColor = dark ? "#fdf6e3" : "#002b36";

  /* ─── Dark mode ─── */

  useEffect(() => {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    setDark(prefersDark);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  /* ─── Render remote ops ─── */

  const renderOps = useCallback((ops: DrawOp[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    for (const op of ops) {
      ctx.globalAlpha = op.o ?? 1;
      if (isDot(op)) {
        ctx.fillStyle = op.c ?? "#000000";
        ctx.beginPath();
        ctx.arc(op.x, op.y, (op.w ?? LINE_WIDTH) / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = op.c ?? "#000000";
        ctx.lineWidth = op.w ?? LINE_WIDTH;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        drawSmoothPath(ctx, op.pts);
      }
    }
    ctx.globalAlpha = 1;
  }, []);

  /* ─── Overlay ─── */

  const redrawOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    const main = canvasRef.current;
    if (!overlay || !main) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    const pts = activePoints.current;
    const widths = activeWidths.current;
    if (pts.length < 4) return;

    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.strokeStyle = main.dataset.ink || "#000000";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 1;

    const numPoints = pts.length / 2;

    if (numPoints === 2) {
      ctx.lineWidth = widths[1] ?? widths[0] ?? LINE_WIDTH;
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      ctx.lineTo(pts[2], pts[3]);
      ctx.stroke();
    } else {
      // Draw per-segment with midpoint bezier, each at its own width.
      // Segment i connects midpoint(p[i-1],p[i]) to midpoint(p[i],p[i+1])
      // with control point p[i], using width[i].

      // First segment: line from p0 to midpoint(p0,p1)
      const m0x = (pts[0] + pts[2]) / 2, m0y = (pts[1] + pts[3]) / 2;
      ctx.lineWidth = widths[0] ?? LINE_WIDTH;
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      ctx.lineTo(m0x, m0y);
      ctx.stroke();

      // Middle segments
      for (let i = 1; i < numPoints - 1; i++) {
        const pi = i * 2;
        const mx1 = (pts[pi - 2] + pts[pi]) / 2;
        const my1 = (pts[pi - 1] + pts[pi + 1]) / 2;
        const mx2 = (pts[pi] + pts[pi + 2]) / 2;
        const my2 = (pts[pi + 1] + pts[pi + 3]) / 2;
        ctx.lineWidth = widths[i] ?? LINE_WIDTH;
        ctx.beginPath();
        ctx.moveTo(mx1, my1);
        ctx.quadraticCurveTo(pts[pi], pts[pi + 1], mx2, my2);
        ctx.stroke();
      }

      // Last segment: midpoint(pN-2,pN-1) to pN-1
      const last = numPoints - 1;
      const li = last * 2;
      const mlx = (pts[li - 2] + pts[li]) / 2, mly = (pts[li - 1] + pts[li + 1]) / 2;
      ctx.lineWidth = widths[last] ?? LINE_WIDTH;
      ctx.beginPath();
      ctx.moveTo(mlx, mly);
      ctx.lineTo(pts[li], pts[li + 1]);
      ctx.stroke();
    }
  }, []);

  const commitOverlay = useCallback((opacity: number) => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.globalAlpha = opacity;
    ctx.drawImage(overlay, 0, 0);
    ctx.globalAlpha = 1;
    overlay.getContext("2d")?.clearRect(0, 0, overlay.width, overlay.height);
  }, []);

  const clearCanvas = useCallback(() => {
    canvasRef.current?.getContext("2d")?.clearRect(
      0, 0, canvasRef.current.width, canvasRef.current.height
    );
  }, []);

  /* ─── Network ─── */

  const lastSentCursor = useRef<Point>({ x: -1, y: -1 });
  const immediateQueue = useRef<{ event: string; data: unknown }[]>([]);
  const sending = useRef(false);

  const sendBatch = useCallback(() => {
    if (sending.current) return;
    const events: { event: string; data: unknown }[] = [];

    if (batch.current.length > 0) {
      events.push({ event: "draw", data: { ops: [...batch.current] } });
      batch.current = [];
    }

    if (socketIdRef.current) {
      const dx = cursorPos.current.x - lastSentCursor.current.x;
      const dy = cursorPos.current.y - lastSentCursor.current.y;
      if (dx * dx + dy * dy > CURSOR_MOVE_THRESHOLD * CURSOR_MOVE_THRESHOLD) {
        events.push({
          event: "cursor",
          data: {
            id: myId.current,
            x: Math.round(cursorPos.current.x),
            y: Math.round(cursorPos.current.y),
            color: myColor.current,
          },
        });
        lastSentCursor.current = { ...cursorPos.current };
      }
    }

    if (immediateQueue.current.length > 0) {
      events.push(...immediateQueue.current);
      immediateQueue.current = [];
    }

    if (events.length === 0) return;
    sending.current = true;
    fetch("/api/draw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room, batch: events, socketId: socketIdRef.current }),
    })
      .catch(() => {})
      .finally(() => { sending.current = false; });
  }, [room]);

  const flushPending = useCallback(() => {
    if (pendingPoints.current.length >= 4) {
      const color = canvasRef.current?.dataset.ink || "#000000";
      const o = Math.round(pendingOpacity.current * 100) / 100;
      const w = Math.round(smoothedWidth.current * 10) / 10;
      batch.current.push({
        pts: [...pendingPoints.current],
        c: color, w, ...(o < 1 ? { o } : {}),
      });
      pendingPoints.current = [];
    }
    sendBatch();
  }, [sendBatch]);

  const broadcastClear = useCallback(() => {
    immediateQueue.current.push({ event: "clear", data: {} });
    sendBatch();
  }, [sendBatch]);

  /* ─── Resize ─── */

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    const resize = () => {
      const ctx = canvas.getContext("2d");
      const img = ctx?.getImageData(0, 0, canvas.width, canvas.height);
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      overlay.width = window.innerWidth;
      overlay.height = window.innerHeight;
      if (img) ctx?.putImageData(img, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  /* ─── Pusher ─── */

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
    if (!key || !cluster) return;
    const pusher = new Pusher(key, { cluster });
    pusher.connection.bind("connected", () => {
      socketIdRef.current = pusher.connection.socket_id;
      setConnected(true);
    });
    pusher.connection.bind("disconnected", () => setConnected(false));
    const channel = pusher.subscribe(`room-${room}`);
    channel.bind("draw", (data: DrawEvent) => renderOps(data.ops));
    channel.bind("clear", () => clearCanvas());
    channel.bind("cursor", (data: CursorEvent) => {
      setRemoteCursors((prev) => {
        const now = Date.now();
        return [
          ...prev.filter((c) => c.id !== data.id && now - c.lastSeen < CURSOR_EXPIRE_MS),
          { ...data, lastSeen: now },
        ];
      });
    });
    return () => { pusher.unsubscribe(`room-${room}`); pusher.disconnect(); };
  }, [room, renderOps, clearCanvas]);

  /* ─── Send loop ─── */

  useEffect(() => {
    const timer = setInterval(() => {
      if (pendingPoints.current.length >= 4) {
        const color = canvasRef.current?.dataset.ink || "#000000";
        const o = Math.round(pendingOpacity.current * 100) / 100;
        const w = Math.round(smoothedWidth.current * 10) / 10;
        batch.current.push({
          pts: [...pendingPoints.current],
          c: color, w, ...(o < 1 ? { o } : {}),
        });
        pendingPoints.current = pendingPoints.current.slice(-2);
      }
      sendBatch();
    }, SEND_INTERVAL);
    return () => { clearInterval(timer); sendBatch(); };
  }, [sendBatch]);

  /* ─── Expire cursors ─── */

  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setRemoteCursors((prev) => prev.filter((c) => now - c.lastSeen < CURSOR_EXPIRE_MS));
    }, 2000);
    return () => clearInterval(t);
  }, []);

  /* ─── Pointer + Force Touch ─── */

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;

    const getPoint = (e: { clientX: number; clientY: number }): Point => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const getOpacity = (e: PointerEvent): number => {
      if (hasForceTouch.current && currentForce.current > 0) {
        return forceToOpacity(currentForce.current);
      }
      if (e.pressure > 0 && e.pressure !== 0.5) {
        return pressureToOpacity(e.pressure);
      }
      return 1;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onForceChange = (e: any) => {
      hasForceTouch.current = true;
      currentForce.current = e.webkitForce ?? 0;
      if (isDrawing.current) {
        const o = forceToOpacity(currentForce.current);
        activeOpacity.current = o;
        pendingOpacity.current = o;
        overlay.style.opacity = String(o);
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      e.preventDefault();
      try { overlay.setPointerCapture(e.pointerId); } catch {}
      isDrawing.current = true;
      hasMoved.current = false;
      smoothedWidth.current = LINE_WIDTH;
      lastMoveTime.current = performance.now();

      const pt = getPoint(e);
      lastMovePos.current = { x: pt.x, y: pt.y };
      activePoints.current.length = 0;
      activeWidths.current = [];
      pendingPoints.current = [];
      activePoints.current.push(pt.x, pt.y);
      activeWidths.current.push(LINE_WIDTH);
      pendingPoints.current.push(pt.x, pt.y);
      activeOpacity.current = getOpacity(e);
      pendingOpacity.current = activeOpacity.current;
      overlay.style.opacity = String(activeOpacity.current);
    };

    const onPointerMove = (e: PointerEvent) => {
      const pt = getPoint(e);
      cursorPos.current = pt;
      setLocalCursor({ x: pt.x, y: pt.y });

      if (!isDrawing.current) return;
      e.preventDefault();
      hasMoved.current = true;

      // Compute velocity → target width (fast = thin, slow = thick)
      const now = performance.now();
      const dt = Math.max(1, now - lastMoveTime.current); // ms
      const dx = pt.x - lastMovePos.current.x;
      const dy = pt.y - lastMovePos.current.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const speed = dist / dt; // px/ms

      // Map speed to width: speed ~0 → MAX, speed ~2+ px/ms → MIN
      const speedNorm = Math.min(1, speed / 2);
      const targetWidth = LINE_WIDTH_MAX - (LINE_WIDTH_MAX - LINE_WIDTH_MIN) * speedNorm;
      smoothedWidth.current += (targetWidth - smoothedWidth.current) * WIDTH_LERP;

      lastMoveTime.current = now;
      lastMovePos.current = { x: pt.x, y: pt.y };

      const opacity = getOpacity(e);
      activePoints.current.push(pt.x, pt.y);
      activeWidths.current.push(smoothedWidth.current);
      pendingPoints.current.push(pt.x, pt.y);
      activeOpacity.current = opacity;
      pendingOpacity.current = opacity;
      overlay.style.opacity = String(opacity);
      redrawOverlay();
    };

    const onPointerUp = () => {
      if (!isDrawing.current) return;

      if (!hasMoved.current && activePoints.current.length >= 2) {
        // Dot
        const x = activePoints.current[0], y = activePoints.current[1];
        const color = canvas.dataset.ink || "#000000";
        const o = Math.round(activeOpacity.current * 100) / 100;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.globalAlpha = o;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x, y, LINE_WIDTH / 2, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        batch.current.push({ x, y, dot: true, c: color, w: LINE_WIDTH, ...(o < 1 ? { o } : {}) } as Dot);
        overlay.getContext("2d")?.clearRect(0, 0, overlay.width, overlay.height);
      } else {
        commitOverlay(activeOpacity.current);
      }

      flushPending();
      activePoints.current.length = 0;
      activeWidths.current = [];
      pendingPoints.current = [];
      overlay.style.opacity = "1";
      isDrawing.current = false;
      hasMoved.current = false;
      currentForce.current = 0;
    };

    const onPointerEnter = () => setCursorVisible(true);
    const onPointerLeave = () => {
      setCursorVisible(false);
      if (isDrawing.current) onPointerUp();
    };

    overlay.addEventListener("pointerdown", onPointerDown);
    overlay.addEventListener("pointermove", onPointerMove);
    overlay.addEventListener("pointerup", onPointerUp);
    overlay.addEventListener("pointerenter", onPointerEnter);
    overlay.addEventListener("pointerleave", onPointerLeave);
    overlay.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("webkitmouseforcechanged", onForceChange);
    overlay.addEventListener("webkitmouseforcechanged", onForceChange);

    return () => {
      overlay.removeEventListener("pointerdown", onPointerDown);
      overlay.removeEventListener("pointermove", onPointerMove);
      overlay.removeEventListener("pointerup", onPointerUp);
      overlay.removeEventListener("pointerenter", onPointerEnter);
      overlay.removeEventListener("pointerleave", onPointerLeave);
      overlay.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("webkitmouseforcechanged", onForceChange);
      overlay.removeEventListener("webkitmouseforcechanged", onForceChange);
    };
  }, [flushPending, redrawOverlay, commitOverlay]);

  /* ─── Handlers ─── */

  const handleClear = () => {
    clearCanvas();
    broadcastClear();
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="relative h-full w-full dot-grid">
      <div className="top-bar">
        <div className="flex items-center gap-3">
          <span className="logo">Pictionary</span>
          <button onClick={handleCopyLink} className="badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            {copied ? "Copied!" : "Copy Link"}
          </button>
          {connected && (
            <span className="live-dot" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setDark((d) => !d)} className="badge" aria-label="Toggle dark mode">
            {dark ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          <button onClick={handleClear} className="badge">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>

      {/* Remote cursors */}
      {remoteCursors.map((c) => (
        <div key={c.id} className="remote-cursor" style={{ left: c.x, top: c.y }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill={cursorColor} stroke={dark ? "#1a1410" : "#fdf6e3"} strokeWidth="1">
            <path d="M2 2l6 16 2.5-6.5L17 9z" />
          </svg>
          <span className="remote-cursor-label" style={{ background: cursorColor, color: dark ? "#1a1410" : "#fdf6e3" }}>
            Player
          </span>
        </div>
      ))}

      {/* Virtual local cursor — filled circle, 2× line width */}
      {cursorVisible && localCursor && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: localCursor.x - CURSOR_SIZE / 2,
            top: localCursor.y - CURSOR_SIZE / 2,
            width: CURSOR_SIZE,
            height: CURSOR_SIZE,
            borderRadius: "50%",
            backgroundColor: cursorColor,
            zIndex: 25,
          }}
        />
      )}

      <canvas ref={canvasRef} className="absolute inset-0 touch-none" style={{ zIndex: 1, cursor: "none" }} data-ink={inkColor} />
      <canvas ref={overlayRef} className="absolute inset-0 touch-none" style={{ zIndex: 2, cursor: "none" }} />
    </div>
  );
}
