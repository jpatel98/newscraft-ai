import {
  findAgentByCommandName,
  findAgentByMention,
} from "@/lib/agents/registry";
import {
  mergeSiteScopes,
  normalizeSiteTarget,
  parseSiteScopeTokens,
} from "@/lib/site-scope";
import type { SiteScope } from "@/lib/types";

export type ParsedProducerInput =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | {
      kind: "command";
      agentId: string;
      commandName: string;
      intent: string;
      cleanedPrompt: string;
      siteScope: SiteScope;
    };

export const HELP_REPLY =
  "**Commands**\n\n" +
  "- `/expert <brief>` — broad expert discovery across the web.\n" +
  "- `/scan-site <domain> <brief>` — restrict the search to one organization.\n" +
  "- `@expertise-finder <brief>` — at-mention from any channel.\n\n" +
  "Add `site:domain.com` or paste a URL anywhere in the message to scope the search.";

const MENTION_PATTERN = /@[a-z0-9-]+/gi;

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

  const mentionedAgent = findAgentByMention(message);

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

  if (!mentionedAgent) {
    return {
      kind: "error",
      message:
        "Summon an agent with a `/command` or an `@mention` — try `/help` for options.",
    };
  }

  const withoutMentions = message
    .replace(MENTION_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  const extracted = parseSiteScopeTokens(withoutMentions);

  if (!extracted.cleanedText) {
    return {
      kind: "error",
      message: "Add a brief after the @mention so the agent knows where to start.",
    };
  }

  return {
    kind: "command",
    agentId: mentionedAgent.id,
    commandName: mentionedAgent.mention,
    intent: "freeform",
    cleanedPrompt: extracted.cleanedText,
    siteScope: extracted.siteScope,
  };
}
