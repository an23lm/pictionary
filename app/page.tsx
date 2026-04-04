import { redirect } from "next/navigation";

export default function Home() {
  const id = Math.random().toString(36).slice(2, 10);
  redirect(`/${id}`);
}
