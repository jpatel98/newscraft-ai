import type { ChannelRow } from "@/db/schema";

export const FRONTEND_CHANNELS = ["experts", "digest"] as const;
export type WorkspaceChannelSlug = (typeof FRONTEND_CHANNELS)[number];

type ChannelConfig = {
  canonicalName: string;
  allowedCommands: readonly string[];
};

type CanonicalConfig = {
  experts: ChannelConfig;
  digest: ChannelConfig;
};

const WORKSPACE_CHANNELS: CanonicalConfig = {
  experts: {
    canonicalName: "Experts",
    allowedCommands: ["/expert", "/clear"],
  },
  digest: {
    canonicalName: "Digest",
    allowedCommands: ["/digest", "/clear"],
  },
} as const;

const CANONICAL_AGENT_IDS = new Set(["expertise-finder", "news-monitor"]);

export type VisibleChannel = ChannelRow & {
  slug: WorkspaceChannelSlug;
  name: string;
};

export function getCanonicalWorkspaceChannelSlug(
  slug: string,
): WorkspaceChannelSlug | null {
  const normalized = slug.toLowerCase();
  return FRONTEND_CHANNELS.includes(normalized as WorkspaceChannelSlug)
    ? (normalized as WorkspaceChannelSlug)
    : null;
}

export function projectVisibleChannels(rawChannels: ChannelRow[]): VisibleChannel[] {
  const seen = new Map<WorkspaceChannelSlug, ChannelRow>();
  for (const channel of rawChannels) {
    const canonical = getCanonicalWorkspaceChannelSlug(channel.slug);
    if (!canonical) continue;

    const existing = seen.get(canonical);
    if (!existing || existing.slug === canonical) {
      seen.set(canonical, channel);
    }
  }

  return FRONTEND_CHANNELS.map((canonical) => {
    const row = seen.get(canonical);
    if (!row) return null;
    return {
      ...row,
      slug: canonical,
      name: WORKSPACE_CHANNELS[canonical].canonicalName,
    };
  }).filter((row): row is VisibleChannel => row !== null);
}

export function getAllowedCommandsForChannelSlug(
  slug: string,
): readonly string[] {
  const canonical = getCanonicalWorkspaceChannelSlug(slug);
  if (!canonical) return [];
  return WORKSPACE_CHANNELS[canonical].allowedCommands;
}

export function isVisibleFrontendAgent(agentId: string): boolean {
  return CANONICAL_AGENT_IDS.has(agentId);
}

export function isExpertHistoryChannel(slug: string): boolean {
  return getCanonicalWorkspaceChannelSlug(slug) === "experts";
}
