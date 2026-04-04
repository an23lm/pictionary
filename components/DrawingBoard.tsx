"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import Pusher from "pusher-js";

interface Point {
  x: number;
  y: number;
}

interface DrawEvent {
  segments: { x1: number; y1: number; x2: number; y2: number }[];
}

const LINE_WIDTH = 2;
const LINE_COLOR = "#000000";
const BATCH_INTERVAL = 50;

export default function DrawingBoard({ room }: { room: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawing = useRef(false);
  const lastPoint = useRef<Point | null>(null);
  const batch = useRef<DrawEvent["segments"]>([]);
  const batchTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const socketId = useRef<string>("");
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(false);

  const getCtx = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth = LINE_WIDTH;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    return ctx;
  }, []);

  const drawSegments = useCallback(
    (segments: DrawEvent["segments"]) => {
      const ctx = getCtx();
      if (!ctx) return;
      for (const seg of segments) {
        ctx.beginPath();
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(seg.x2, seg.y2);
        ctx.stroke();
      }
    },
    [getCtx]
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
    const segments = [...batch.current];
    batch.current = [];
    fetch("/api/draw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room,
        event: "draw",
        data: { segments },
        socketId: socketId.current,
      }),
    }).catch(() => {});
  }, [room]);

  // Resize canvas to fill viewport
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      // Save current drawing
      const imageData = canvas
        .getContext("2d")
        ?.getImageData(0, 0, canvas.width, canvas.height);

      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;

      // Restore drawing after resize
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
      drawSegments(data.segments);
    });

    channel.bind("clear", () => {
      clearCanvas();
    });

    return () => {
      pusher.unsubscribe(`room-${room}`);
      pusher.disconnect();
    };
  }, [room, drawSegments, clearCanvas]);

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
    lastPoint.current = getCanvasPoint(e);
  };

  const handlePointerMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing.current || !lastPoint.current) return;
    e.preventDefault();

    const point = getCanvasPoint(e);
    const segment = {
      x1: lastPoint.current.x,
      y1: lastPoint.current.y,
      x2: point.x,
      y2: point.y,
    };

    // Draw locally immediately
    drawSegments([segment]);

    // Queue for broadcast
    batch.current.push(segment);

    lastPoint.current = point;
  };

  const handlePointerUp = () => {
    if (isDrawing.current) {
      flushBatch();
    }
    isDrawing.current = false;
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
            className="flex items-center gap-1.5 rounded-md bg-[var(--solarized-base2)] px-2.5 py-1 text-xs text-[var(--solarized-base01)] hover:bg-[var(--dot-color)] transition-colors cursor-pointer"
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
            <span className="flex items-center gap-1 text-xs text-green-700">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
              Live
            </span>
          )}
        </div>
        <button
          onClick={handleClear}
          className="pointer-events-auto rounded-md bg-[var(--solarized-base2)] px-2.5 py-1 text-xs text-[var(--solarized-base01)] hover:bg-red-200 hover:text-red-800 transition-colors cursor-pointer"
        >
          Clear Board
        </button>
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
