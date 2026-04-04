"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import Pusher from "pusher-js";

interface Point {
  x: number;
  y: number;
}

type Segment = { x1: number; y1: number; x2: number; y2: number };
type Dot = { x: number; y: number; dot: true };
type DrawOp = Segment | Dot;

interface DrawEvent {
  ops: DrawOp[];
}

const LINE_WIDTH = 3;
const DOT_RADIUS = 2;
const BATCH_INTERVAL = 50;

function isDot(op: DrawOp): op is Dot {
  return "dot" in op;
}

export default function DrawingBoard({ room }: { room: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawing = useRef(false);
  const hasMoved = useRef(false);
  const lastPoint = useRef<Point | null>(null);
  const batch = useRef<DrawOp[]>([]);
  const batchTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const socketId = useRef<string>("");
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(false);
  const [dark, setDark] = useState(false);

  // Initialize dark mode from system preference
  useEffect(() => {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    setDark(prefersDark);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Apply dark class to html element
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const getInkColor = useCallback(() => {
    return getComputedStyle(document.documentElement)
      .getPropertyValue("--ink-color")
      .trim();
  }, []);

  const drawOps = useCallback(
    (ops: DrawOp[]) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const color = getInkColor();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = LINE_WIDTH;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      for (const op of ops) {
        if (isDot(op)) {
          ctx.beginPath();
          ctx.arc(op.x, op.y, DOT_RADIUS, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(op.x1, op.y1);
          // Quadratic curve for smoother lines — use midpoint as control point
          const cx = (op.x1 + op.x2) / 2;
          const cy = (op.y1 + op.y2) / 2;
          ctx.quadraticCurveTo(op.x1, op.y1, cx, cy);
          ctx.lineTo(op.x2, op.y2);
          ctx.stroke();
        }
      }
    },
    [getInkColor]
  );

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const flushBatch = useCallback(() => {
    if (batch.current.length === 0) return;
    const ops = [...batch.current];
    batch.current = [];
    fetch("/api/draw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room,
        event: "draw",
        data: { ops },
        socketId: socketId.current,
      }),
    }).catch(() => {});
  }, [room]);

  // Resize canvas to fill viewport
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const imageData = canvas
        .getContext("2d")
        ?.getImageData(0, 0, canvas.width, canvas.height);

      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;

      if (imageData) {
        canvas.getContext("2d")?.putImageData(imageData, 0, 0);
      }
    };

    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // Connect to Pusher
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;

    if (!key || !cluster) {
      console.warn("Pusher env vars not set — real-time sync disabled");
      return;
    }

    const pusher = new Pusher(key, { cluster });

    pusher.connection.bind("connected", () => {
      socketId.current = pusher.connection.socket_id;
      setConnected(true);
    });

    pusher.connection.bind("disconnected", () => setConnected(false));

    const channel = pusher.subscribe(`room-${room}`);

    channel.bind("draw", (data: DrawEvent) => {
      drawOps(data.ops);
    });

    channel.bind("clear", () => {
      clearCanvas();
    });

    return () => {
      pusher.unsubscribe(`room-${room}`);
      pusher.disconnect();
    };
  }, [room, drawOps, clearCanvas]);

  // Batch flush interval
  useEffect(() => {
    batchTimer.current = setInterval(flushBatch, BATCH_INTERVAL);
    return () => {
      if (batchTimer.current) clearInterval(batchTimer.current);
      flushBatch();
    };
  }, [flushBatch]);

  const getCanvasPoint = (e: React.MouseEvent | React.TouchEvent): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const clientX =
      "touches" in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY =
      "touches" in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  };

  const handlePointerDown = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    isDrawing.current = true;
    hasMoved.current = false;
    lastPoint.current = getCanvasPoint(e);
  };

  const handlePointerMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing.current || !lastPoint.current) return;
    e.preventDefault();
    hasMoved.current = true;

    const point = getCanvasPoint(e);
    const segment: Segment = {
      x1: lastPoint.current.x,
      y1: lastPoint.current.y,
      x2: point.x,
      y2: point.y,
    };

    drawOps([segment]);
    batch.current.push(segment);
    lastPoint.current = point;
  };

  const handlePointerUp = () => {
    if (isDrawing.current) {
      // Click without drag — draw a dot
      if (!hasMoved.current && lastPoint.current) {
        const dot: Dot = {
          x: lastPoint.current.x,
          y: lastPoint.current.y,
          dot: true,
        };
        drawOps([dot]);
        batch.current.push(dot);
      }
      flushBatch();
    }
    isDrawing.current = false;
    hasMoved.current = false;
    lastPoint.current = null;
  };

  const handleClear = () => {
    clearCanvas();
    fetch("/api/draw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room,
        event: "clear",
        data: {},
        socketId: socketId.current,
      }),
    }).catch(() => {});
  };

  const handleCopyLink = () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="relative h-full w-full dot-grid">
      {/* Toolbar */}
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-2 pointer-events-none">
        <div className="flex items-center gap-3 pointer-events-auto">
          <h1 className="text-sm font-semibold tracking-tight text-[var(--solarized-base01)] select-none">
            Pictionary
          </h1>
          <div className="h-4 w-px bg-[var(--solarized-base2)]" />
          <button
            onClick={handleCopyLink}
            className="flex items-center gap-1.5 rounded-md bg-[var(--solarized-base2)] px-2.5 py-1 text-xs text-[var(--solarized-base01)] hover:bg-[var(--toolbar-hover)] transition-colors cursor-pointer"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            {copied ? "Copied!" : "Share Link"}
          </button>
          {connected && (
            <span className="flex items-center gap-1 text-xs text-green-700 dark:text-green-400">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
              Live
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 pointer-events-auto">
          <button
            onClick={() => setDark((d) => !d)}
            className="rounded-md bg-[var(--solarized-base2)] p-1.5 text-[var(--solarized-base01)] hover:bg-[var(--toolbar-hover)] transition-colors cursor-pointer"
            aria-label="Toggle dark mode"
          >
            {dark ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          <button
            onClick={handleClear}
            className="rounded-md bg-[var(--solarized-base2)] px-2.5 py-1 text-xs text-[var(--solarized-base01)] hover:bg-red-200 hover:text-red-800 transition-colors cursor-pointer"
          >
            Clear Board
          </button>
        </div>
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 cursor-crosshair touch-none"
        onMouseDown={handlePointerDown}
        onMouseMove={handlePointerMove}
        onMouseUp={handlePointerUp}
        onMouseLeave={handlePointerUp}
        onTouchStart={handlePointerDown}
        onTouchMove={handlePointerMove}
        onTouchEnd={handlePointerUp}
        onTouchCancel={handlePointerUp}
      />
    </div>
  );
}
