import type { SiteScope } from "@/lib/types";

function cleanupToken(value: string) {
  return value.trim().replace(/[),.;]+$/g, "");
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function toHttpsUrl(domain: string) {
  return `https://${domain}`;
}

export function emptySiteScope(): SiteScope {
  return {
    allowedDomains: [],
    preferredUrls: [],
  };
}

export function normalizeSiteTarget(rawValue: string) {
  const value = cleanupToken(rawValue);

  if (!value) {
    return null;
  }

  try {
    const directUrl = new URL(value);
    const domain = stripWww(directUrl.hostname);

    return {
      domain,
      url: directUrl.toString(),
    };
  } catch {
    try {
      const url = new URL(value.includes("://") ? value : toHttpsUrl(value));
      const domain = stripWww(url.hostname);

      return {
        domain,
        url: url.toString(),
      };
    } catch {
      return null;
    }
  }
}

function stripWww(hostname: string) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

export function isAllowedDomain(url: string, allowedDomains: string[]) {
  if (allowedDomains.length === 0) {
    return true;
  }

  try {
    const hostname = stripWww(new URL(url).hostname);

    return allowedDomains.some(
      (domain) =>
        hostname === stripWww(domain) ||
        hostname.endsWith(`.${stripWww(domain)}`),
    );
  } catch {
    return false;
  }
}

export function mergeSiteScopes(...scopes: SiteScope[]): SiteScope {
  return {
    allowedDomains: unique(
      scopes.flatMap((scope) => scope.allowedDomains.map(stripWww)),
    ),
    preferredUrls: unique(scopes.flatMap((scope) => scope.preferredUrls)),
  };
}

export function parseSiteScopeTokens(input: string) {
  const collectedDomains = new Set<string>();
  const collectedUrls = new Set<string>();
  let cleanedText = input;

  cleanedText = cleanedText.replace(
    /\b(?:site|domain):([^\s]+)/gi,
    (_match, rawValue) => {
      const normalized = normalizeSiteTarget(rawValue);

      if (normalized) {
        collectedDomains.add(normalized.domain);
      }

      return " ";
    },
  );

  cleanedText = cleanedText.replace(/\burl:(https?:\/\/[^\s]+)/gi, (_match, rawValue) => {
    const normalized = normalizeSiteTarget(rawValue);

    if (normalized) {
      collectedDomains.add(normalized.domain);
      collectedUrls.add(normalized.url);
    }

    return " ";
  });

  cleanedText = cleanedText.replace(/https?:\/\/[^\s]+/gi, (rawValue) => {
    const normalized = normalizeSiteTarget(rawValue);

    if (normalized) {
      collectedDomains.add(normalized.domain);
      collectedUrls.add(normalized.url);
    }

    return " ";
  });

  return {
    cleanedText: cleanedText.replace(/\s+/g, " ").trim(),
    siteScope: {
      allowedDomains: [...collectedDomains],
      preferredUrls: [...collectedUrls],
    } satisfies SiteScope,
  };
}
