import { db } from "@/db/client";
import { agents, channels, workspaces } from "@/db/schema";
import { listAgents } from "@/lib/agents/registry";

const WORKSPACE_ID = "default";

type TopicSeed = { slug: string; name: string; sortOrder: number };

const TOPIC_CHANNELS: TopicSeed[] = [
  { slug: "booking", name: "booking", sortOrder: 100 },
  { slug: "research", name: "research", sortOrder: 101 },
  { slug: "news-digest", name: "news-digest", sortOrder: 102 },
];

async function main() {
  await db
    .insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "NewsCraft" })
    .onConflictDoNothing();

  const registry = listAgents();

  for (const agent of registry) {
    await db
      .insert(agents)
      .values({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        iconKey: agent.iconKey,
        capabilities: agent.capabilities,
      })
      .onConflictDoUpdate({
        target: agents.id,
        set: {
          name: agent.name,
          description: agent.description,
          iconKey: agent.iconKey,
          capabilities: agent.capabilities,
        },
      });
  }

  for (let i = 0; i < registry.length; i++) {
    const agent = registry[i];
    await db
      .insert(channels)
      .values({
        id: `channel-dm-${agent.id}`,
        workspaceId: WORKSPACE_ID,
        kind: "agent_dm",
        slug: agent.id,
        name: agent.name,
        agentId: agent.id,
        sortOrder: i,
      })
      .onConflictDoNothing();
  }

  for (const topic of TOPIC_CHANNELS) {
    await db
      .insert(channels)
      .values({
        id: `channel-topic-${topic.slug}`,
        workspaceId: WORKSPACE_ID,
        kind: "topic",
        slug: topic.slug,
        name: topic.name,
        agentId: null,
        sortOrder: topic.sortOrder,
      })
      .onConflictDoNothing();
  }

  console.log("Seeded workspace `default` with agents + channels.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
