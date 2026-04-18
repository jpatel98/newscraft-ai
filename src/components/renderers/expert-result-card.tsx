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

  return (
    <article className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
      <header className="flex items-center gap-2 pb-2">
        <span className="eyebrow text-[var(--fg-subtle)]">
          Expert shortlist
        </span>
        <span
          className="ml-auto text-xs"
          style={{ color: confidence.color }}
        >
          {confidence.label}
        </span>
      </header>

      <p className="text-[0.9375rem] leading-relaxed text-[var(--fg)]">
        {result.summary}
      </p>

      <p className="mt-2 text-sm text-[var(--fg-muted)]">
        <span className="font-medium text-[var(--fg)]">Editorial angle:</span>{" "}
        {result.editorialAngle}
      </p>

      {result.experts.length > 0 ? (
        <ol className="mt-4 flex flex-col gap-3">
          {result.experts.map((expert, index) => (
            <li
              key={`${expert.name}-${index}`}
              className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg)] p-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-[var(--fg)]">
                  {expert.name}
                </h3>
                <span className="text-xs uppercase tracking-wider text-[var(--fg-subtle)]">
                  {expert.bookingSignal}
                </span>
              </div>
              <p className="text-sm text-[var(--fg-muted)]">
                {expert.role}, {expert.organization}
                {expert.location ? ` · ${expert.location}` : ""}
              </p>
              <p className="mt-2 text-sm text-[var(--fg)]">
                <span className="font-medium">Why:</span> {expert.whyRelevant}
              </p>
              <p className="mt-1 text-sm text-[var(--fg)]">
                <span className="font-medium">Angle:</span>{" "}
                {expert.reachoutAngle}
              </p>
              {expert.sources.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-1.5 text-xs">
                  {expert.sources.map((source, i) => (
                    <li key={`${source.url}-${i}`}>
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[var(--fg-muted)] hover:border-[var(--border-strong)] hover:text-[var(--fg)]"
                      >
                        {source.title}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-sm text-[var(--fg-muted)]">
          No strong candidates surfaced — try widening the brief or scoping to a
          different site.
        </p>
      )}

      {result.nextMoves.length > 0 ? (
        <section className="mt-4">
          <div className="eyebrow pb-1 text-[var(--fg-subtle)]">Next moves</div>
          <ul className="list-disc pl-5 text-sm text-[var(--fg)]">
            {result.nextMoves.map((move, i) => (
              <li key={i}>{move}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.watchouts.length > 0 ? (
        <section className="mt-3">
          <div className="eyebrow pb-1 text-[var(--fg-subtle)]">Watchouts</div>
          <ul className="list-disc pl-5 text-sm text-[var(--fg-muted)]">
            {result.watchouts.map((watchout, i) => (
              <li key={i}>{watchout}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
