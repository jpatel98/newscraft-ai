import { redirect } from "next/navigation";
import { listChannels } from "@/db/queries/channels";

const WORKSPACE_ID = "default";

export default async function Home() {
  const channels = await listChannels(WORKSPACE_ID);
  if (channels.length === 0) return null;
  redirect(`/channel/${channels[0].slug}`);
}
