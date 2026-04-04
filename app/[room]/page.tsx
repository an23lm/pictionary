import DrawingBoard from "@/components/DrawingBoard";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ room: string }>;
}) {
  const { room } = await params;

  return <DrawingBoard room={room} />;
}
