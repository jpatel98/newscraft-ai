"use client";

import type { ExpertiseFinderResult } from "@/lib/types";

export function ExpertResultCard({
  result,
}: {
  result: ExpertiseFinderResult;
}) {
  const experts = Array.isArray(result.experts) ? result.experts : [];
  const contextUrls = Array.isArray(result.contextUrls) ? result.contextUrls : [];

  return (
    <article className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
      {contextUrls.length > 0 ? (
        <p className="pb-2 text-xs text-[var(--fg-subtle)]">
          <span className="font-medium text-[var(--fg-muted)]">
            Context URL analyzed:
          </span>{" "}
          {contextUrls.map((url, index) => (
            <span key={`${url}-${index}`}>
              {index > 0 ? ", " : ""}
              <ExternalLink href={url} label={url} />
            </span>
          ))}
        </p>
      ) : null}

      {experts.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {experts.map((rawExpert, index) => {
            const expert = normalizeExpert(rawExpert);

            return (
              <li
                key={`${expert.name}-${index}`}
                className="min-w-0 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg)] p-3"
              >
                <h3 className="text-sm font-semibold text-[var(--fg)]">
                  {index + 1}) {expert.name}
                </h3>
                <div className="mt-2 min-w-0 space-y-1.5 text-sm">
                  <p className="min-w-0 text-[var(--fg-muted)]">
                    <span className="font-medium text-[var(--fg)]">Role:</span>{" "}
                    {expert.role}, {expert.organization}
                  </p>
                  <p className="min-w-0 text-[var(--fg)]">
                    <span className="font-medium">Why {firstName(expert.name)}:</span>{" "}
                    {expert.whyRelevant}
                  </p>
                  <p className="min-w-0 text-[var(--fg)]">
                    <span className="font-medium">Contact:</span>{" "}
                    {expert.email || "not publicly listed"}
                  </p>
                  {expert.phone ? (
                    <p className="min-w-0 text-[var(--fg)]">
                      <span className="font-medium">Phone:</span> {expert.phone}
                    </p>
                  ) : null}
                  {expert.website ? (
                    <p className="min-w-0 text-[var(--fg)]">
                      <span className="font-medium">Website:</span>{" "}
                      <ExternalLink href={expert.website} label={expert.website} />
                    </p>
                  ) : null}
                  {expert.socials.map((social, i) => (
                    <p
                      key={`${social.label}-${social.value}-${i}`}
                      className="min-w-0 text-[var(--fg)]"
                    >
                      <span className="font-medium">Also:</span>{" "}
                      {isUrl(social.value) ? (
                        <ExternalLink href={social.value} label={social.value} />
                      ) : (
                        social.value
                      )}
                    </p>
                  ))}
                  {expert.otherLinks.map((link, i) => (
                    <p
                      key={`${link.title}-${link.url}-${i}`}
                      className="min-w-0 text-[var(--fg)]"
                    >
                      <span className="font-medium">{link.title}:</span>{" "}
                      <ExternalLink href={link.url} label={link.url} />
                    </p>
                  ))}
                  {expert.contactNote ? (
                    <p className="min-w-0 text-sm text-[var(--fg-muted)]">
                      {expert.contactNote}
                    </p>
                  ) : null}
                  {expert.source ? (
                    <p className="min-w-0 text-[var(--fg)]">
                      <span className="font-medium">Source:</span>{" "}
                      <ExternalLink href={expert.source.url} label={expert.source.url} />
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-sm text-[var(--fg-muted)]">
          No strong candidates surfaced — try widening the brief or scoping to a
          different site.
        </p>
      )}
    </article>
  );
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || "them";
}

function normalizePersonName(name: string) {
  const cleaned = name.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Unnamed expert";

  const tokens = cleaned.split(" ");
  if (tokens.length < 3) return cleaned;

  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const middle = tokens.slice(1, -1);

  const normalizedMiddle = middle.map((token) =>
    token.replace(/\.+$/g, "").toUpperCase(),
  );
  const repeatedInitial =
    normalizedMiddle.length >= 2 &&
    normalizedMiddle.every(
      (token) => token.length === 1 && token === normalizedMiddle[0],
    );

  if (repeatedInitial) {
    return `${first} ${last}`;
  }

  return cleaned;
}

function normalizeExpert(rawExpert: unknown) {
  const expert = (rawExpert ?? {}) as {
    name?: string;
    role?: string;
    organization?: string;
    whyRelevant?: string;
    email?: string;
    phone?: string;
    website?: string;
    socials?: Array<{ label?: string; value?: string }>;
    otherLinks?: Array<{ title?: string; url?: string }>;
    source?: { title?: string; url?: string };
    contactNote?: string;
    reachoutAngle?: string;
    sources?: Array<{ title?: string; url?: string }>;
  };

  const socialsRaw = Array.isArray(expert.socials)
    ? expert.socials
        .filter((social) => social?.value)
        .map((social) => ({
          label: social.label || "Profile",
          value: social.value || "",
        }))
    : [];
  const socials = uniqueBy(socialsRaw, (social) =>
    normalizeComparable(social.value),
  );

  const otherLinksRaw = Array.isArray(expert.otherLinks)
    ? expert.otherLinks
        .filter((link) => link?.url)
        .map((link) => ({
          title: link.title || "Link",
          url: link.url || "",
        }))
    : [];
  const otherLinks = uniqueBy(otherLinksRaw, (link) =>
    normalizeComparable(link.url),
  );

  const legacySourcesRaw = Array.isArray(expert.sources)
    ? expert.sources
        .filter((link) => link?.url)
        .map((link) => ({
          title: link.title || "Source",
          url: link.url || "",
        }))
    : [];
  const legacySources = uniqueBy(legacySourcesRaw, (link) =>
    normalizeComparable(link.url),
  );

  const source =
    expert.source?.url
      ? {
          title: expert.source.title || "Source",
          url: expert.source.url,
        }
      : legacySources[0];

  const linksWithoutSource = (source ? otherLinks : legacySources.slice(1)).filter(
    (link) =>
      !source || normalizeComparable(link.url) !== normalizeComparable(source.url),
  );

  return {
    name: normalizePersonName(expert.name || "Unnamed expert"),
    role: expert.role || "Role not listed",
    organization: expert.organization || "Organization not listed",
    whyRelevant:
      expert.whyRelevant || expert.reachoutAngle || "Relevant to this topic.",
    email: expert.email || "not publicly listed",
    phone: expert.phone || "",
    website: expert.website || "",
    socials,
    otherLinks: linksWithoutSource,
    source,
    contactNote: expert.contactNote || "",
  };
}

function uniqueBy<T>(values: T[], getKey: (value: T) => string) {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const value of values) {
    const key = getKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }

  return result;
}

function normalizeComparable(value: string) {
  return value.trim().toLowerCase();
}

function isUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline break-all text-[var(--accent-link)] hover:underline"
    >
      {label}
    </a>
  );
}
