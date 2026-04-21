import {
  allCommandSuggestions,
  findAgentByCommandName,
} from "@/lib/agents/catalog";
import {
  mergeSiteScopes,
  normalizeSiteTarget,
  parseSiteScopeTokens,
} from "@/lib/site-scope";
import type { SiteScope } from "@/lib/types";

export type ParsedProducerInput =
  | { kind: "help"; allowedCommands: string[] }
  | { kind: "clear" }
  | { kind: "error"; message: string }
  | {
      kind: "command";
      agentId: string;
      commandName: string;
      intent: string;
      cleanedPrompt: string;
      siteScope: SiteScope;
    };

type ParseOptions = {
  allowedCommands?: readonly string[];
};

const COMMAND_ORDER = [
  "/expert",
  "/scan-site",
  "/scout",
  "/digest",
  "/sources",
  "/help",
  "/clear",
] as const;

function sortCommands(commands: string[]) {
  return [...commands].sort((a, b) => {
    const aIndex = COMMAND_ORDER.indexOf(a as (typeof COMMAND_ORDER)[number]);
    const bIndex = COMMAND_ORDER.indexOf(b as (typeof COMMAND_ORDER)[number]);
    return (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) -
      (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex) ||
      a.localeCompare(b);
  });
}

const LEGACY_MENTION_MAP: Record<string, string> = {
  "@expertise-finder": "/expert",
  "@story-scout": "/scout",
  "@news-monitor": "/digest",
};

function normalizeAllowedCommands(commands?: readonly string[]) {
  return commands ? commands.map((command) => command.toLowerCase()) : [];
}

function buildAllowedSet(commands?: string[]) {
  const normalized = new Set<string>();
  for (const command of normalizeAllowedCommands(commands)) {
    normalized.add(command);
  }
  return normalized;
}

function formatAllowedCommandList(commands: string[]) {
  const unique = Array.from(new Set(sortCommands(commands)));
  const quoted = unique.map((command) => `\`${command}\``);
  if (quoted.length === 0) return "";
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
}

function buildHelpReply(allowedCommands: string[]) {
  const allowedSet = buildAllowedSet(allowedCommands);
  const suggestions = sortCommands(
    allCommandSuggestions()
      .filter((item) => allowedSet.has(item.name.toLowerCase()))
      .map((item) => item.name),
  );
  const lines = ["**Commands**", ""];
  const includeHelp = allowedSet.has("/help");

  for (const command of suggestions) {
    const descriptor = allCommandSuggestions().find(
      (item) => item.name === command,
    );
    if (descriptor) {
      lines.push(`- \`${descriptor.name}\` — ${descriptor.summary}`);
    }
  }

  if (includeHelp) {
    lines.push("- `/help` — list the available commands and agent mentions.");
  }
  if (allowedSet.has("/clear")) {
    lines.push("- `/clear` — clear this channel's chat history.");
  }

  if (suggestions.length > 0 || includeHelp || allowedSet.has("/clear")) {
    lines.push("");
    lines.push(
      "Add `site:domain.com` to scope a search. Paste a URL anywhere in the message to use it as story context.",
    );
  }

  return lines.join("\n");
}

function buildChannelRestrictionMessage(allowedCommands: string[]) {
  const readable = formatAllowedCommandList(allowedCommands);
  return readable
    ? `Run one of ${readable} for this channel.`
    : "This channel does not accept slash commands.";
}

function isCommandAllowed(rawCommand: string, allowedSet: Set<string>) {
  return allowedSet.size === 0 || allowedSet.has(rawCommand.toLowerCase());
}

export function parseProducerInput(
  rawMessage: string,
  options: ParseOptions = {},
): ParsedProducerInput {
  const allowedCommands = normalizeAllowedCommands(options.allowedCommands);
  const allowedSet = buildAllowedSet(allowedCommands);
  const enforceAllowed = options.allowedCommands !== undefined;
  const message = rawMessage.trim();

  if (!message) {
    return {
      kind: "error",
      message: "Add a brief so the agent has something to work on.",
    };
  }

  if (message === "/help") {
    if (enforceAllowed && !isCommandAllowed(message, allowedSet)) {
      return {
        kind: "error",
        message: buildChannelRestrictionMessage(allowedCommands),
      };
    }
    return { kind: "help", allowedCommands };
  }

  if (message === "/clear") {
    if (enforceAllowed && !isCommandAllowed(message, allowedSet)) {
      return {
        kind: "error",
        message: buildChannelRestrictionMessage(allowedCommands),
      };
    }
    return { kind: "clear" };
  }

  if (message.startsWith("/")) {
    const [rawCommand, ...rest] = message.split(/\s+/);

    if (enforceAllowed && !isCommandAllowed(rawCommand, allowedSet)) {
      return {
        kind: "error",
        message: buildChannelRestrictionMessage(allowedCommands),
      };
    }

    const match = findAgentByCommandName(rawCommand);
    if (!match) {
      return {
        kind: "error",
        message: `Unknown command ${rawCommand}. ${buildChannelRestrictionMessage(allowedCommands)}`,
      };
    }

    const restText = rest.join(" ").trim();

    if (match.command.requiresSite) {
      const [siteTarget, ...promptParts] = restText.split(/\s+/);
      const normalized = siteTarget ? normalizeSiteTarget(siteTarget) : null;

      if (!normalized) {
        return {
          kind: "error",
          message: `${match.command.name} needs a site or URL first. Example: ${match.command.example}`,
        };
      }

      const extracted = parseSiteScopeTokens(promptParts.join(" "));

      if (!extracted.cleanedText) {
        return {
          kind: "error",
          message: `Add a brief after ${match.command.name}. Example: ${match.command.example}`,
        };
      }

      return {
        kind: "command",
        agentId: match.agent.id,
        commandName: match.command.name,
        intent: match.command.intent,
        cleanedPrompt: extracted.cleanedText,
        siteScope: mergeSiteScopes(
          {
            allowedDomains: [normalized.domain],
            preferredUrls: [normalized.url],
          },
          extracted.siteScope,
        ),
      };
    }

    const extracted = parseSiteScopeTokens(restText);
    const requiresPrompt = match.command.requiresPrompt !== false;

    if (!extracted.cleanedText && requiresPrompt) {
      return {
        kind: "error",
        message: `Add a brief after ${match.command.name}. Example: ${match.command.example}`,
      };
    }

    return {
      kind: "command",
      agentId: match.agent.id,
      commandName: match.command.name,
      intent: match.command.intent,
      cleanedPrompt: extracted.cleanedText || match.command.name,
      siteScope: extracted.siteScope,
    };
  }

  const legacyMention = Object.entries(LEGACY_MENTION_MAP).find(([mention]) =>
    message.toLowerCase().includes(mention),
  );
  if (legacyMention) {
    const replacement = legacyMention[1];
    if (enforceAllowed && !isCommandAllowed(replacement, allowedSet)) {
      return {
        kind: "error",
        message: buildChannelRestrictionMessage(allowedCommands),
      };
    }
    return {
      kind: "error",
      message: `NewsCraft now uses slash commands only. Replace ${legacyMention[0]} with ${replacement}.`,
    };
  }

  return {
    kind: "error",
    message: buildChannelRestrictionMessage(allowedCommands),
  };
}

export { buildHelpReply };
