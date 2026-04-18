"use client";

import type { DailyDigest } from "@/lib/agents/news-monitor";

export function DigestCard({ digest }: { digest: DailyDigest }) {
  return (
    <article className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
      <header className="flex items-center gap-2 pb-2">
        <span className="eyebrow text-[var(--fg-subtle)]">Daily digest</span>
        <span className="ml-auto text-xs text-[var(--fg-muted)]">
          {digest.dateKey}
        </span>
      </header>

      <h2 className="text-base font-semibold text-[var(--fg)]">
        {digest.headline}
      </h2>
      <p className="mt-2 text-[0.9375rem] leading-relaxed text-[var(--fg)]">
        {digest.summary}
      </p>

      {digest.items.length > 0 ? (
        <ol className="mt-4 flex flex-col gap-2">
          {digest.items.map((item, i) => (
            <li
              key={i}
              className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg)] p-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                <a
                  href={item.url ?? item.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-sm font-semibold text-[var(--fg)] hover:text-[var(--accent-link)]"
                >
                  {item.headline}
                </a>
                <span className="text-xs text-[var(--fg-muted)]">
                  {item.sourceLabel}
                  {item.publishedAt ? ` · ${item.publishedAt}` : ""}
                </span>
              </div>
              <p className="mt-1 text-sm text-[var(--fg)]">{item.summary}</p>
              <p className="mt-1 text-sm text-[var(--fg-muted)]">
                <span className="font-medium text-[var(--fg)]">Why:</span>{" "}
                {item.why}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-sm text-[var(--fg-muted)]">
          No new items today.
        </p>
      )}

      {digest.producerNotes.length > 0 ? (
        <section className="mt-4">
          <div className="eyebrow pb-1 text-[var(--fg-subtle)]">
            Producer notes
          </div>
          <ul className="list-disc pl-5 text-sm text-[var(--fg-muted)]">
            {digest.producerNotes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
