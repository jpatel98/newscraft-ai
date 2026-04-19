import type { ChannelRow } from "@/db/schema";

type ChannelCommandGuidance = {
  headerCommands: string[];
  placeholder: string;
  emptyState: string;
};

const COMMAND_RENDERERS: Record<string, string> = {
  "/expert": "expert",
  "/scan-site": "expert",
  "/scout": "scout",
  "/digest": "digest",
  "/sources": "digest",
};

const MENTION_RENDERERS: Record<string, string> = {
  "@expertise-finder": "expert",
  "@story-scout": "scout",
  "@news-monitor": "digest",
};

export function getChannelCommandGuidance(
  channel: Pick<ChannelRow, "slug" | "name">,
): ChannelCommandGuidance {
  if (channel.slug === "news-digest") {
    return {
      headerCommands: ["/digest", "/sources", "/scout"],
      placeholder:
        "Run /digest, manage sources with /sources, or @mention an agent",
      emptyState:
        "No messages yet. Try /digest to run today's roundup, /sources to manage the watchlist, or /help to see everything available.",
    };
  }

  if (channel.slug === "research") {
    return {
      headerCommands: ["/scout", "/expert", "/digest"],
      placeholder:
        "Message this channel — use /scout, /expert, /digest, /help, or @mention an agent",
      emptyState:
        "No messages yet. Try /scout for a story brief, /expert for source discovery, or /help to see everything available.",
    };
  }

  return {
    headerCommands: ["/expert", "/scout", "/digest"],
    placeholder:
      "Message this channel — use /expert, /scout, /digest, /help, or @mention an agent",
    emptyState:
      "No messages yet. Try /expert, /scout, or /digest, or type /help to see everything available.",
  };
}

export function previewRequestedRenderer(rawMessage: string) {
  const message = rawMessage.trim().toLowerCase();
  if (!message || message === "/help" || message === "/clear") return null;

  if (message.startsWith("/")) {
    const [command] = message.split(/\s+/);
    return COMMAND_RENDERERS[command] ?? null;
  }

  for (const [mention, renderer] of Object.entries(MENTION_RENDERERS)) {
    if (message.includes(mention)) return renderer;
  }

  return null;
}
