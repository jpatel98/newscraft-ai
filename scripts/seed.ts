import { db } from "@/db/client";
import {
  agents,
  channels,
  users,
  workspaceMemberships,
  workspaces,
} from "@/db/schema";
import { seedWorkspaceAgentSettings } from "@/db/queries/agents";
import { listAgents } from "@/lib/agents/registry";

const WORKSPACE_ID = "default";
const DEV_ADMIN_ID = "user-admin";
const DEV_ADMIN_EMAIL =
  process.env.NEWSCRAFT_DEV_USER_EMAIL ?? "admin@newscraft.local";

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

  await db
    .insert(users)
    .values({
      id: DEV_ADMIN_ID,
      email: DEV_ADMIN_EMAIL,
      name: "NewsCraft Admin",
      globalRole: "admin",
    })
    .onConflictDoNothing();

  await db
    .insert(workspaceMemberships)
    .values({
      workspaceId: WORKSPACE_ID,
      userId: DEV_ADMIN_ID,
      role: "owner",
    })
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

  await seedWorkspaceAgentSettings(WORKSPACE_ID, {
    id: DEV_ADMIN_ID,
    email: DEV_ADMIN_EMAIL,
    name: "NewsCraft Admin",
    globalRole: "admin",
    createdAt: Date.now(),
  });

  console.log(
    `Seeded workspace \`${WORKSPACE_ID}\` with agents, topic channels, and local admin ${DEV_ADMIN_EMAIL}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
