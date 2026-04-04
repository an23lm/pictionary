import { redirect } from "next/navigation";
import { nanoid } from "nanoid";

export default function Home() {
  const roomId = nanoid(8);
  redirect(`/${roomId}`);
}
