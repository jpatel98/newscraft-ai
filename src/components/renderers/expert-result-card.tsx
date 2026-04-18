"use client";

import type { ExpertiseFinderResult } from "@/lib/types";

const confidenceLabel: Record<
  ExpertiseFinderResult["confidence"],
  { label: string; color: string }
> = {
  high: { label: "High confidence", color: "var(--success)" },
  medium: { label: "Medium confidence", color: "#b7791f" },
  low: { label: "Low confidence", color: "var(--danger)" },
};

export function ExpertResultCard({
  result,
}: {
  result: ExpertiseFinderResult;
}) {
  const confidence = confidenceLabel[result.confidence];
  const topic = result.topic || "Expert shortlist";
  const storyAngle = result.storyAngle || "";
  const experts = Array.isArray(result.experts) ? result.experts : [];
  const nextMoves = Array.isArray(result.nextMoves) ? result.nextMoves : [];
  const watchouts = Array.isArray(result.watchouts) ? result.watchouts : [];

  return (
    <article className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
      <header className="flex flex-wrap items-center gap-2 pb-2">
        <span className="eyebrow text-[var(--fg-subtle)]">Expert Finder Results</span>
        <span
          className="ml-auto text-xs"
          style={{ color: confidence.color }}
        >
          {confidence.label}
        </span>
      </header>

      <div className="space-y-1 text-sm">
        <p className="text-[var(--fg)]">
          <span className="font-medium">Topic:</span> {topic}
        </p>
        {storyAngle ? (
          <p className="text-[var(--fg-muted)]">
            <span className="font-medium text-[var(--fg)]">Story angle:</span>{" "}
            {storyAngle}
          </p>
        ) : null}
      </div>

      <p className="text-[0.9375rem] leading-relaxed text-[var(--fg)]">
        {result.summary}
      </p>

      {experts.length > 0 ? (
        <ol className="mt-4 flex flex-col gap-3">
          {experts.map((rawExpert, index) => {
            const expert = normalizeExpert(rawExpert);

            return (
            <li
              key={`${expert.name}-${index}`}
              className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg)] p-3"
            >
              <h3 className="text-sm font-semibold text-[var(--fg)]">
                {index + 1}) {expert.name}
              </h3>
              <div className="mt-2 space-y-1.5 text-sm">
                <p className="text-[var(--fg-muted)]">
                  <span className="font-medium text-[var(--fg)]">Role:</span>{" "}
                  {expert.role}, {expert.organization}
                </p>
                <p className="text-[var(--fg)]">
                  <span className="font-medium">Why {firstName(expert.name)}:</span>{" "}
                  {expert.whyRelevant}
                </p>
                <p className="text-[var(--fg)]">
                  <span className="font-medium">Contact:</span>{" "}
                  {expert.email || "not publicly listed"}
                </p>
                {expert.phone ? (
                  <p className="text-[var(--fg)]">
                    <span className="font-medium">Phone:</span> {expert.phone}
                  </p>
                ) : null}
                {expert.website ? (
                  <p className="text-[var(--fg)]">
                    <span className="font-medium">Website:</span>{" "}
                    <ExternalLink href={expert.website} label={expert.website} />
                  </p>
                ) : null}
                {expert.socials.map((social, i) => (
                  <p key={`${social.label}-${social.value}-${i}`} className="text-[var(--fg)]">
                    <span className="font-medium">Also:</span>{" "}
                    {isUrl(social.value) ? (
                      <ExternalLink href={social.value} label={social.value} />
                    ) : (
                      social.value
                    )}
                  </p>
                ))}
                {expert.otherLinks.map((link, i) => (
                  <p key={`${link.title}-${link.url}-${i}`} className="text-[var(--fg)]">
                    <span className="font-medium">{link.title}:</span>{" "}
                    <ExternalLink href={link.url} label={link.url} />
                  </p>
                ))}
                {expert.contactNote ? (
                  <p className="text-sm text-[var(--fg-muted)]">
                    {expert.contactNote}
                  </p>
                ) : null}
                {expert.source ? (
                  <p className="text-[var(--fg)]">
                    <span className="font-medium">Source:</span>{" "}
                    <ExternalLink href={expert.source.url} label={expert.source.url} />
                  </p>
                ) : null}
              </div>
            </li>
          )})}
        </ol>
      ) : (
        <p className="mt-3 text-sm text-[var(--fg-muted)]">
          No strong candidates surfaced — try widening the brief or scoping to a
          different site.
        </p>
      )}

      {nextMoves.length > 0 ? (
        <section className="mt-4">
          <div className="eyebrow pb-1 text-[var(--fg-subtle)]">Next moves</div>
          <ul className="list-disc pl-5 text-sm text-[var(--fg)]">
            {nextMoves.map((move, i) => (
              <li key={i}>{move}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {watchouts.length > 0 ? (
        <section className="mt-3">
          <div className="eyebrow pb-1 text-[var(--fg-subtle)]">Watchouts</div>
          <ul className="list-disc pl-5 text-sm text-[var(--fg-muted)]">
            {watchouts.map((watchout, i) => (
              <li key={i}>{watchout}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || "them";
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

  const socials = Array.isArray(expert.socials)
    ? expert.socials
        .filter((social) => social?.value)
        .map((social) => ({
          label: social.label || "Profile",
          value: social.value || "",
        }))
    : [];

  const otherLinks = Array.isArray(expert.otherLinks)
    ? expert.otherLinks
        .filter((link) => link?.url)
        .map((link) => ({
          title: link.title || "Link",
          url: link.url || "",
        }))
    : [];

  const legacySources = Array.isArray(expert.sources)
    ? expert.sources
        .filter((link) => link?.url)
        .map((link) => ({
          title: link.title || "Source",
          url: link.url || "",
        }))
    : [];

  const source =
    expert.source?.url
      ? {
          title: expert.source.title || "Source",
          url: expert.source.url,
        }
      : legacySources[0];

  return {
    name: expert.name || "Unnamed expert",
    role: expert.role || "Role not listed",
    organization: expert.organization || "Organization not listed",
    whyRelevant:
      expert.whyRelevant || expert.reachoutAngle || "Relevant to this topic.",
    email: expert.email || "not publicly listed",
    phone: expert.phone || "",
    website: expert.website || "",
    socials,
    otherLinks: source ? otherLinks : legacySources.slice(1),
    source,
    contactNote: expert.contactNote || "",
  };
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
      className="text-[var(--accent-link)] hover:underline"
    >
      {label}
    </a>
  );
}
