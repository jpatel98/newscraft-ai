import { db } from "@/db/client";
import { agents, channels, workspaces } from "@/db/schema";
import { listAgents } from "@/lib/agents/registry";

const WORKSPACE_ID = "default";

const TOPIC_CHANNELS = [
  { slug: "general", name: "general", sortOrder: 100 },
  { slug: "research", name: "research", sortOrder: 101 },
  { slug: "news-digest", name: "news-digest", sortOrder: 102 },
];

async function main() {
  await db
    .insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "NewsCraft" })
    .onConflictDoNothing();

  for (const agent of listAgents()) {
    await db
      .insert(agents)
      .values({
        id: agent.id,
        name: agent.defaultName,
        description: agent.description,
        iconKey: agent.iconKey,
        capabilities: agent.capabilities,
        instructions: agent.defaults.instructions,
        model: null,
        enabledTools: agent.defaults.enabledTools,
      })
      .onConflictDoUpdate({
        target: agents.id,
        set: {
          description: agent.description,
          iconKey: agent.iconKey,
          capabilities: agent.capabilities,
        },
      });
  }

  for (const topic of TOPIC_CHANNELS) {
    await db
      .insert(channels)
      .values({
        id: `channel-${topic.slug}`,
        workspaceId: WORKSPACE_ID,
        kind: "topic",
        slug: topic.slug,
        name: topic.name,
        agentId: null,
        sortOrder: topic.sortOrder,
      })
      .onConflictDoNothing();
  }

  console.log("Seeded workspace `default` with agents + topic channels.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
