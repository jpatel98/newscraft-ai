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
  | { kind: "help" }
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

const HELP_REPLY = buildHelpReply();

function buildHelpReply() {
  const lines = ["**Commands**", ""];
  const suggestions = allCommandSuggestions();

  for (const command of sortCommands(
    [...suggestions.map((item) => item.name), "/help", "/clear"],
  )) {
    const descriptor = suggestions.find(
      (item) => item.name === command,
    );
    if (descriptor) {
      lines.push(`- \`${descriptor.name}\` — ${descriptor.summary}`);
      continue;
    }

    if (command === "/help") {
      lines.push("- `/help` — list the available commands and agent mentions.");
      continue;
    }

    if (command === "/clear") {
      lines.push("- `/clear` — clear this channel's chat history.");
    }
  }

  lines.push("");
  lines.push(
    "Add `site:domain.com` to scope a search. Paste a URL anywhere in the message to use it as story context.",
  );

  return lines.join("\n");
}

export { HELP_REPLY };
const LEGACY_MENTION_MAP: Record<string, string> = {
  "@expertise-finder": "/expert",
  "@story-scout": "/scout",
  "@news-monitor": "/digest",
};

export function parseProducerInput(rawMessage: string): ParsedProducerInput {
  const message = rawMessage.trim();

  if (!message) {
    return {
      kind: "error",
      message: "Add a brief so the agent has something to work on.",
    };
  }

  if (message === "/help") {
    return { kind: "help" };
  }

  if (message === "/clear") {
    return { kind: "clear" };
  }

  if (message.startsWith("/")) {
    const [rawCommand, ...rest] = message.split(/\s+/);
    const match = findAgentByCommandName(rawCommand);

    if (!match) {
      return {
        kind: "error",
        message: `Unknown command ${rawCommand}. Try /help to see available commands.`,
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
          message: `Add a brief after the site. Example: ${match.command.example}`,
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
    return {
      kind: "error",
      message: `NewsCraft now uses slash commands only. Replace ${legacyMention[0]} with ${legacyMention[1]}, or try /help.`,
    };
  }

  if (!message) {
    return {
      kind: "error",
      message: "Add a brief so the agent has something to work on.",
    };
  }

  return {
    kind: "error",
    message: "Run a newsroom action with a slash command like /expert, /scout, /digest, or /sources. Try /help for options.",
  };
}
