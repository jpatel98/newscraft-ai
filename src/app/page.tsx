import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agents as agentsTable } from "@/db/schema";
import { getChannelBySlug, listChannels } from "@/db/queries/channels";
import { listMessagesByChannel } from "@/db/queries/messages";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";
import type { ChatMessage } from "@/lib/hooks/use-agent-stream";

const WORKSPACE_ID = "default";

type SearchParams = Promise<{ channel?: string }>;

export default async function Home({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { channel: channelSlug } = await searchParams;

  const channels = await listChannels(WORKSPACE_ID);
  if (channels.length === 0) {
    return <BootstrapNotice />;
  }

  const agents = await db.select().from(agentsTable);

  const activeChannel = channelSlug
    ? (await getChannelBySlug(WORKSPACE_ID, channelSlug)) ?? channels[0]
    : channels[0];

  const rawMessages = await listMessagesByChannel(activeChannel.id);
  const initialMessages: ChatMessage[] = rawMessages
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({
      id: row.id,
      role: row.role as ChatMessage["role"],
      agentId: row.agentId,
      content: row.content,
      payload: row.payload ?? null,
      renderer: row.renderer,
      createdAt: row.createdAt,
    }));

  const activeAgent = activeChannel.agentId
    ? (
        await db
          .select()
          .from(agentsTable)
          .where(eq(agentsTable.id, activeChannel.agentId))
      )[0] ?? null
    : null;

  return (
    <WorkspaceShell
      channels={channels}
      agents={agents}
      activeChannel={activeChannel}
      activeAgent={activeAgent}
      initialMessages={initialMessages}
    />
  );
}

function BootstrapNotice() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md text-sm text-[var(--fg-muted)]">
        <h1 className="text-lg font-semibold text-[var(--fg)] mb-2">
          Workspace not seeded
        </h1>
        <p>
          Run <code className="wkbench-kbd">npm run db:migrate</code> then{" "}
          <code className="wkbench-kbd">npm run db:seed</code> to bootstrap the
          default workspace and channels.
        </p>
      </div>
    </main>
  );
}
