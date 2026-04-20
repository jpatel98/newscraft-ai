"use client";

import type { StoryScoutBrief } from "@/lib/agents/story-scout";
import { Markdown } from "./markdown";

export function ScoutBriefCard({ brief }: { brief: StoryScoutBrief }) {
  return (
    <article className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
      <header className="flex items-center gap-2 pb-2">
        <span className="eyebrow text-[var(--fg-subtle)]">Story intelligence</span>
        <span className="ml-auto text-xs text-[var(--fg-muted)]">
          {brief.confidence} confidence
        </span>
      </header>

      <h2 className="text-base font-semibold text-[var(--fg)]">{brief.topic}</h2>
      <Markdown
        content={brief.summary}
        className="mt-2 text-[0.9375rem] leading-relaxed text-[var(--fg)]"
      />

      {brief.background.length > 0 ? (
        <section className="mt-4">
          <div className="eyebrow pb-1 text-[var(--fg-subtle)]">Background</div>
          <ul className="flex flex-col gap-1.5 text-sm">
            {brief.background.map((item, i) => (
              <li key={i} className="text-[var(--fg)]">
                {item.fact}{" "}
                <a
                  href={item.source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-[var(--accent-link)] hover:underline"
                >
                  {item.source.title}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {brief.relatedCoverage.length > 0 ? (
        <section className="mt-4">
          <div className="eyebrow pb-1 text-[var(--fg-subtle)]">
            Related coverage
          </div>
          <ul className="flex flex-col gap-1.5 text-sm">
            {brief.relatedCoverage.map((item, i) => (
              <li key={i}>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-medium text-[var(--fg)] hover:text-[var(--accent-link)]"
                >
                  {item.headline}
                </a>{" "}
                <span className="text-[var(--fg-muted)]">
                  — {item.outlet}
                  {item.publishedAt ? ` · ${item.publishedAt}` : ""}
                </span>
                <Markdown
                  content={item.takeaway}
                  className="text-[var(--fg-muted)]"
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
