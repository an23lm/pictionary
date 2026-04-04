import Pusher from "pusher";

let pusher: Pusher | null = null;

if (
  process.env.PUSHER_APP_ID &&
  process.env.NEXT_PUBLIC_PUSHER_KEY &&
  process.env.PUSHER_SECRET &&
  process.env.NEXT_PUBLIC_PUSHER_CLUSTER
) {
  pusher = new Pusher({
    appId: process.env.PUSHER_APP_ID,
    key: process.env.NEXT_PUBLIC_PUSHER_KEY,
    secret: process.env.PUSHER_SECRET,
    cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER,
    useTLS: true,
  });
}

interface BatchItem {
  event: string;
  data: unknown;
}

export async function POST(request: Request) {
  if (!pusher) {
    return Response.json(
      { error: "Pusher not configured" },
      { status: 503 }
    );
  }

  const body = (await request.json()) as {
    room: string;
    socketId?: string;
    batch?: BatchItem[];
    event?: string;
    data?: unknown;
  };

  const channel = `room-${body.room}`;
  const excludeOpts = body.socketId ? { socket_id: body.socketId } : undefined;

  // Legacy single-event format (no batch array)
  if (!body.batch) {
    if (body.event) {
      await pusher.trigger(channel, body.event, body.data ?? {}, excludeOpts);
    }
    return Response.json({ ok: true });
  }

  // Batched: use Pusher's triggerBatch to send all events in one HTTP call
  const items = body.batch;
  if (items.length === 1) {
    await pusher.trigger(channel, items[0].event, items[0].data, excludeOpts);
  } else if (items.length > 1) {
    await pusher.triggerBatch(
      items.map((item) => ({
        channel,
        name: item.event,
        data: item.data,
        ...(excludeOpts ? { socket_id: excludeOpts.socket_id } : {}),
      }))
    );
  }

  return Response.json({ ok: true });
}
