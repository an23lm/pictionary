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

export async function POST(request: Request) {
  if (!pusher) {
    return Response.json(
      { error: "Pusher not configured" },
      { status: 503 }
    );
  }

  const { room, event, data, socketId } = await request.json();

  await pusher.trigger(`room-${room}`, event, data, {
    socket_id: socketId || undefined,
  });

  return Response.json({ ok: true });
}
