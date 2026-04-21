import type { ChannelRow } from "@/db/schema";
import { getAllowedCommandsForChannelSlug } from "@/lib/workspace-channels";

type ChannelCommandGuidance = {
  headerCommands: readonly string[];
  placeholder: string;
  emptyState: string;
};

const COMMAND_RENDERERS: Record<string, string> = {
  "/expert": "expert",
  "/digest": "digest",
};

function joinCommands(commands: string[]) {
  const quoted = commands.map((command) => command);
  if (quoted.length === 0) return "";
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted.at(-1)}`;
}

export function getChannelCommandGuidance(
  channel: Pick<ChannelRow, "slug" | "name">,
): ChannelCommandGuidance {
  const allowed = getAllowedCommandsForChannelSlug(channel.slug);
  const actionCommands = allowed.filter((command) => command !== "/clear");

  if (actionCommands.length === 0) {
    return {
      headerCommands: allowed,
      placeholder: "Use /help to show available commands.",
      emptyState: "No commands are enabled for this channel.",
    };
  }

  const verbPhrase =
    actionCommands.length === 1
      ? `Use ${actionCommands[0]}`
      : `Use ${joinCommands(actionCommands)}`;
  const helperPhrase = allowed.includes("/clear")
    ? ` or ${"/clear"} to reset this channel.`
    : ".";

  return {
    headerCommands: allowed,
    placeholder: `${verbPhrase}${helperPhrase}`,
    emptyState: `${verbPhrase.toLowerCase().replace(/^use /, "Try ")}${helperPhrase}`,
  };
}

export function previewRequestedRenderer(rawMessage: string) {
  const message = rawMessage.trim().toLowerCase();
  if (!message || message === "/help" || message === "/clear") return null;

  if (message.startsWith("/")) {
    const [command] = message.split(/\s+/);
    return COMMAND_RENDERERS[command] ?? null;
  }

  return null;
}
