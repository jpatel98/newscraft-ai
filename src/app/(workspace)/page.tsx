import { redirect } from "next/navigation";
import { listChannels } from "@/db/queries/channels";
import { getCurrentAppContext } from "@/lib/server/app-context";

export default async function Home() {
  const { workspace } = await getCurrentAppContext();
  const channels = await listChannels(workspace.id);
  if (channels.length === 0) return null;
  redirect(`/channel/${channels[0].slug}`);
}
