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

// Dot grid animation
const DOT_SPACING = 28;
const DOT_RADIUS = 1.8;
const DOT_REPEL_RADIUS = 120; // px — how far the cursor affects dots
const DOT_REPEL_STRENGTH = 6; // px — max displacement at cursor center
const DOT_ATTRACT_STRENGTH = 4; // px — max attraction when drawing
const CURSOR_SIZE_DRAWING = LINE_WIDTH * 4; // larger cursor while drawing
const DOT_RETURN_SPEED = 0.08; // spring return (0–1, lower = more viscous)
const DOT_SCALE_MAX = 2.5;    // max radius multiplier at cursor center

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
  const dotsRef = useRef<HTMLCanvasElement>(null);
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

  // Safe zone: min dimensions across all clients, centered on this screen
  const remoteDims = useRef<{ w: number; h: number } | null>(null);
  const safeZone = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(false);
  const [dark, setDark] = useState(false);
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([]);
  const [localCursor, setLocalCursor] = useState<Point | null>(null);
  const [cursorVisible, setCursorVisible] = useState(false);
  const [isDrawingState, setIsDrawingState] = useState(false);

  // Button hover state
  const hoveredButton = useRef<HTMLElement | null>(null);
  const [cursorOnButton, setCursorOnButton] = useState(false);

  const inkColor = dark ? "#d5c4a1" : "#000000";
  const cursorColor = dark ? "#fdf6e3" : "#002b36";
  const dotColor = dark ? "#332a20" : "#d3cbb7";

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
    const sz = safeZone.current;
    const ox = sz ? sz.x : 0;
    const oy = sz ? sz.y : 0;
    for (const op of ops) {
      ctx.globalAlpha = op.o ?? 1;
      if (isDot(op)) {
        ctx.fillStyle = op.c ?? "#000000";
        ctx.beginPath();
        ctx.arc(op.x + ox, op.y + oy, (op.w ?? LINE_WIDTH) / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Offset stroke points from safe-zone space → screen space
        const pts = op.pts;
        const screenPts = new Array(pts.length);
        for (let i = 0; i < pts.length; i += 2) {
          screenPts[i] = pts[i] + ox;
          screenPts[i + 1] = pts[i + 1] + oy;
        }
        ctx.strokeStyle = op.c ?? "#000000";
        ctx.lineWidth = op.w ?? LINE_WIDTH;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        drawSmoothPath(ctx, screenPts);
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
            x: Math.round(cursorPos.current.x - (safeZone.current?.x ?? 0)),
            y: Math.round(cursorPos.current.y - (safeZone.current?.y ?? 0)),
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
      const pts = [...pendingPoints.current];
      const sz = safeZone.current;
      if (sz) {
        for (let i = 0; i < pts.length; i += 2) {
          pts[i] -= sz.x;
          pts[i + 1] -= sz.y;
        }
      }
      batch.current.push({ pts, c: color, w, ...(o < 1 ? { o } : {}) });
      pendingPoints.current = [];
    }
    sendBatch();
  }, [sendBatch]);

  const broadcastClear = useCallback(() => {
    immediateQueue.current.push({ event: "clear", data: {} });
    sendBatch();
  }, [sendBatch]);

  /* ─── Safe zone calculation ─── */

  const recalcSafeZone = useCallback(() => {
    const localW = window.innerWidth;
    const localH = window.innerHeight;
    const remote = remoteDims.current;
    if (!remote) {
      safeZone.current = null;
      return;
    }
    const safeW = Math.min(localW, remote.w);
    const safeH = Math.min(localH, remote.h);
    safeZone.current = {
      x: (localW - safeW) / 2,
      y: (localH - safeH) / 2,
      w: safeW,
      h: safeH,
    };
  }, []);


  const broadcastDims = useCallback(() => {
    if (!socketIdRef.current) return;
    immediateQueue.current.push({
      event: "dims",
      data: { w: window.innerWidth, h: window.innerHeight },
    });
    sendBatch();
  }, [sendBatch]);

  /* ─── Resize ─── */

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    const dots = dotsRef.current;
    if (!canvas || !overlay || !dots) return;
    const resize = () => {
      const ctx = canvas.getContext("2d");
      const img = ctx?.getImageData(0, 0, canvas.width, canvas.height);
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      overlay.width = window.innerWidth;
      overlay.height = window.innerHeight;
      dots.width = window.innerWidth;
      dots.height = window.innerHeight;
      if (img) ctx?.putImageData(img, 0, 0);
      recalcSafeZone();
      broadcastDims();
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [recalcSafeZone, broadcastDims]);

  /* ─── Animated dot grid ─── */

  useEffect(() => {
    const dotsCanvas = dotsRef.current;
    if (!dotsCanvas) return;

    // Dot state: displaced positions spring back toward grid rest positions
    let dotOffsets: Float32Array | null = null; // [dx, dy, dx, dy, ...] per dot
    let cols = 0;
    let rows = 0;
    let animId = 0;

    const initDots = () => {
      cols = Math.ceil(dotsCanvas.width / DOT_SPACING) + 1;
      rows = Math.ceil(dotsCanvas.height / DOT_SPACING) + 1;
      dotOffsets = new Float32Array(cols * rows * 2); // all zeros = at rest
    };

    initDots();

    const animate = () => {
      const ctx = dotsCanvas.getContext("2d");
      if (!ctx || !dotOffsets) { animId = requestAnimationFrame(animate); return; }

      const w = dotsCanvas.width;
      const h = dotsCanvas.height;
      if (w === 0 || h === 0) { animId = requestAnimationFrame(animate); return; }

      ctx.clearRect(0, 0, w, h);

      // Recalc grid size if canvas resized
      const newCols = Math.ceil(w / DOT_SPACING) + 1;
      const newRows = Math.ceil(h / DOT_SPACING) + 1;
      if (newCols !== cols || newRows !== rows) {
        cols = newCols;
        rows = newRows;
        dotOffsets = new Float32Array(cols * rows * 2);
      }

      const cx = cursorPos.current.x;
      const cy = cursorPos.current.y;
      const r2 = DOT_REPEL_RADIUS * DOT_REPEL_RADIUS;
      const halfSpacing = DOT_SPACING / 2;

      // Read dot color from CSS variable
      const color = getComputedStyle(document.documentElement)
        .getPropertyValue("--dot-color").trim() || "#d3cbb7";

      // Safe zone for fading out-of-bounds dots
      const sz = safeZone.current;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const idx = (row * cols + col) * 2;
          const restX = col * DOT_SPACING + halfSpacing;
          const restY = row * DOT_SPACING + halfSpacing;

          // Compute repulsion from cursor
          const dx = restX - cx;
          const dy = restY - cy;
          const dist2 = dx * dx + dy * dy;

          let proximity = 0; // 0 = far, 1 = at cursor center
          const drawing = isDrawing.current;

          if (dist2 < r2 && dist2 > 0.1) {
            const dist = Math.sqrt(dist2);
            proximity = 1 - dist / DOT_REPEL_RADIUS;
            const strength = drawing ? DOT_ATTRACT_STRENGTH : DOT_REPEL_STRENGTH;
            const force = proximity * strength;
            const nx = dx / dist;
            const ny = dy / dist;
            const dir = drawing ? -1 : 1;
            dotOffsets[idx] += (nx * force * dir - dotOffsets[idx]) * 0.15;
            dotOffsets[idx + 1] += (ny * force * dir - dotOffsets[idx + 1]) * 0.15;
          } else {
            dotOffsets[idx] *= (1 - DOT_RETURN_SPEED);
            dotOffsets[idx + 1] *= (1 - DOT_RETURN_SPEED);
          }

          const drawX = restX + dotOffsets[idx];
          const drawY = restY + dotOffsets[idx + 1];

          // Inside/outside safe zone — dots outside are smaller and fainter
          let sizeMultiplier = 1;
          if (sz) {
            const insideX = restX >= sz.x && restX <= sz.x + sz.w;
            const insideY = restY >= sz.y && restY <= sz.y + sz.h;
            if (!insideX || !insideY) {
              sizeMultiplier = 0.85;
              ctx.globalAlpha = 0.4;
            } else {
              ctx.globalAlpha = 1;
            }
          } else {
            ctx.globalAlpha = 1;
          }

          ctx.fillStyle = color;

          // Scale up dots near cursor + apply safe zone size
          const scale = (1 + (DOT_SCALE_MAX - 1) * proximity * proximity) * sizeMultiplier;
          ctx.beginPath();
          ctx.arc(drawX, drawY, DOT_RADIUS * scale, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.globalAlpha = 1;
      animId = requestAnimationFrame(animate);
    };

    animId = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(animId);
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
      // Broadcast our dimensions to the room
      broadcastDims();
    });
    pusher.connection.bind("disconnected", () => setConnected(false));
    const channel = pusher.subscribe(`room-${room}`);
    channel.bind("draw", (data: DrawEvent) => renderOps(data.ops));
    channel.bind("clear", () => clearCanvas());
    channel.bind("cursor", (data: CursorEvent) => {
      setRemoteCursors((prev) => {
        const now = Date.now();
        const sz = safeZone.current;
        const ox = sz ? sz.x : 0;
        const oy = sz ? sz.y : 0;
        return [
          ...prev.filter((c) => c.id !== data.id && now - c.lastSeen < CURSOR_EXPIRE_MS),
          { ...data, x: data.x + ox, y: data.y + oy, lastSeen: now },
        ];
      });
    });
    channel.bind("dims", (data: { w: number; h: number }) => {
      const changed = !remoteDims.current ||
        remoteDims.current.w !== data.w || remoteDims.current.h !== data.h;
      remoteDims.current = data;
      recalcSafeZone();
      // Reply with our dims so the other client also gets the safe zone
      // Only reply if their dims actually changed (prevents ping-pong)
      if (changed) broadcastDims();
    });
    return () => { pusher.unsubscribe(`room-${room}`); pusher.disconnect(); };
  }, [room, renderOps, clearCanvas, broadcastDims, recalcSafeZone]);

  /* ─── Send loop ─── */

  useEffect(() => {
    const timer = setInterval(() => {
      if (pendingPoints.current.length >= 4) {
        const color = canvasRef.current?.dataset.ink || "#000000";
        const o = Math.round(pendingOpacity.current * 100) / 100;
        const w = Math.round(smoothedWidth.current * 10) / 10;
        const pts = [...pendingPoints.current];
        const sz = safeZone.current;
        if (sz) {
          for (let i = 0; i < pts.length; i += 2) {
            pts[i] -= sz.x;
            pts[i + 1] -= sz.y;
          }
        }
        batch.current.push({ pts, c: color, w, ...(o < 1 ? { o } : {}) });
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

  /* ─── Button hover: cursor melts into button fill ─── */

  useEffect(() => {
    let fillDiv: HTMLDivElement | null = null;

    const clearHover = (e?: MouseEvent) => {
      if (fillDiv && hoveredButton.current) {
        const btn = hoveredButton.current;
        const div = fillDiv;

        if (e) {
          const rect = btn.getBoundingClientRect();
          const exitX = e.clientX - rect.left;
          const exitY = e.clientY - rect.top;
          // Shrink clip-path back to exit point
          div.style.clipPath = `circle(0px at ${exitX}px ${exitY}px)`;
        } else {
          div.style.opacity = "0";
        }

        setTimeout(() => { try { btn.removeChild(div); } catch {} }, 280);
        fillDiv = null;
        hoveredButton.current = null;
      }
      setCursorOnButton(false);
    };

    const onGlobalMove = (e: MouseEvent) => {
      setLocalCursor({ x: e.clientX, y: e.clientY });
      cursorPos.current = { x: e.clientX, y: e.clientY };

      if (isDrawing.current) { clearHover(); return; }

      const el = document.elementFromPoint(e.clientX, e.clientY);
      const interactive = el?.closest("button, a, [role='button']") as HTMLElement | null;

      if (interactive) {
        if (hoveredButton.current !== interactive) {
          clearHover(e);

          hoveredButton.current = interactive;
          setCursorOnButton(true);

          const rect = interactive.getBoundingClientRect();
          const entryX = e.clientX - rect.left;
          const entryY = e.clientY - rect.top;
          // Max radius needed to cover entire button from entry point
          const corners = [[0,0],[rect.width,0],[0,rect.height],[rect.width,rect.height]];
          let maxR = 0;
          for (const [cx, cy] of corners) {
            maxR = Math.max(maxR, Math.sqrt((entryX-cx)**2 + (entryY-cy)**2));
          }
          // Add extra for button expansion (label reveal)
          maxR += 60;

          const isDark = document.documentElement.classList.contains("dark");
          const fillColor = isDark ? "rgba(253, 246, 227, 0.12)" : "rgba(0, 43, 54, 0.18)";

          fillDiv = document.createElement("div");
          fillDiv.style.cssText = `
            position: absolute;
            inset: 0;
            background: ${fillColor};
            clip-path: circle(0px at ${entryX}px ${entryY}px);
            pointer-events: none;
            transition: clip-path 0.28s cubic-bezier(0.25, 0.1, 0.25, 1);
            z-index: 0;
          `;
          // Store max radius for the expand
          fillDiv.dataset.maxR = String(Math.ceil(maxR));
          fillDiv.dataset.entryX = String(entryX);
          fillDiv.dataset.entryY = String(entryY);
          interactive.appendChild(fillDiv);

          requestAnimationFrame(() => {
            if (fillDiv) {
              fillDiv.style.clipPath = `circle(${maxR}px at ${entryX}px ${entryY}px)`;
            }
          });
        }
      } else {
        if (hoveredButton.current) clearHover(e);
      }
    };

    window.addEventListener("mousemove", onGlobalMove);
    return () => { window.removeEventListener("mousemove", onGlobalMove); clearHover(); };
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
      setIsDrawingState(true);
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
      setLocalCursor({ x: e.clientX, y: e.clientY });

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
        const sz = safeZone.current;
        const sx = sz ? x - sz.x : x;
        const sy = sz ? y - sz.y : y;
        batch.current.push({ x: sx, y: sy, dot: true, c: color, w: LINE_WIDTH, ...(o < 1 ? { o } : {}) } as Dot);
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
      setIsDrawingState(false);
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
          <span className="logo-wrap">
            <span className="logo">Pictionary</span>
            <span className="logo-sub" suppressHydrationWarning>made with <span style={{fontSize: '13px'}}>♥</span> for Hugh</span>
          </span>
          <button onClick={handleCopyLink} className="badge" suppressHydrationWarning>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            <span className={`badge-label ${copied ? "visible" : ""}`}>{copied ? "Copied!" : "Copy Link"}</span>
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

      {/* Virtual cursor — fades out when hovering buttons */}
      {localCursor && (
        <div
          className="fixed pointer-events-none"
          style={{
            left: localCursor.x - (isDrawingState ? CURSOR_SIZE_DRAWING : CURSOR_SIZE) / 2,
            top: localCursor.y - (isDrawingState ? CURSOR_SIZE_DRAWING : CURSOR_SIZE) / 2,
            width: isDrawingState ? CURSOR_SIZE_DRAWING : CURSOR_SIZE,
            height: isDrawingState ? CURSOR_SIZE_DRAWING : CURSOR_SIZE,
            borderRadius: "50%",
            backgroundColor: cursorColor,
            opacity: cursorOnButton ? 0 : 1,
            zIndex: 9999,
            transition: "width 0.15s ease, height 0.15s ease, opacity 0.12s ease",
          }}
        />
      )}

      <canvas ref={dotsRef} className="absolute inset-0 touch-none" style={{ zIndex: 0, cursor: "none" }} />
      <canvas ref={canvasRef} className="absolute inset-0 touch-none" style={{ zIndex: 1, cursor: "none" }} data-ink={inkColor} />
      <canvas ref={overlayRef} className="absolute inset-0 touch-none" style={{ zIndex: 2, cursor: "none" }} />
    </div>
  );
}
