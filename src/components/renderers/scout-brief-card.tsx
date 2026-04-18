"use client";

import type { StoryScoutBrief } from "@/lib/agents/story-scout";

const difficultyColor: Record<
  StoryScoutBrief["angles"][number]["difficulty"],
  string
> = {
  easy: "var(--success)",
  medium: "#b7791f",
  ambitious: "var(--danger)",
};

export function ScoutBriefCard({ brief }: { brief: StoryScoutBrief }) {
  return (
    <article className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
      <header className="flex items-center gap-2 pb-2">
        <span className="eyebrow text-[var(--fg-subtle)]">Story brief</span>
        <span className="ml-auto text-xs text-[var(--fg-muted)]">
          {brief.confidence} confidence
        </span>
      </header>

      <h2 className="text-base font-semibold text-[var(--fg)]">{brief.topic}</h2>
      <p className="mt-2 text-[0.9375rem] leading-relaxed text-[var(--fg)]">
        {brief.summary}
      </p>

      {brief.angles.length > 0 ? (
        <section className="mt-4">
          <div className="eyebrow pb-1 text-[var(--fg-subtle)]">Angles</div>
          <ul className="flex flex-col gap-2">
            {brief.angles.map((angle, i) => (
              <li
                key={i}
                className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg)] p-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-[var(--fg)]">
                    {angle.title}
                  </h3>
                  <span
                    className="text-xs uppercase tracking-wider"
                    style={{ color: difficultyColor[angle.difficulty] }}
                  >
                    {angle.difficulty}
                  </span>
                </div>
                <p className="mt-1 text-sm text-[var(--fg-muted)]">
                  {angle.audience}
                </p>
                <p className="mt-1 text-sm text-[var(--fg)]">{angle.why}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
                <div className="text-[var(--fg-muted)]">{item.takeaway}</div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {brief.suggestedVoices.length > 0 ? (
        <section className="mt-4">
          <div className="eyebrow pb-1 text-[var(--fg-subtle)]">
            Voices to consider
          </div>
          <ul className="flex flex-col gap-1 text-sm">
            {brief.suggestedVoices.map((voice, i) => (
              <li key={i}>
                <span className="font-medium text-[var(--fg)]">
                  {voice.name}
                </span>{" "}
                <span className="text-[var(--fg-muted)]">— {voice.role}</span>
                <div className="text-[var(--fg-muted)]">{voice.why}</div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {brief.interviewQuestions.length > 0 ? (
        <section className="mt-4">
          <div className="eyebrow pb-1 text-[var(--fg-subtle)]">
            Interview questions
          </div>
          <ol className="list-decimal pl-5 text-sm text-[var(--fg)]">
            {brief.interviewQuestions.map((question, i) => (
              <li key={i} className="py-0.5">
                {question}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {brief.watchouts.length > 0 ? (
        <section className="mt-4">
          <div className="eyebrow pb-1 text-[var(--fg-subtle)]">Watchouts</div>
          <ul className="list-disc pl-5 text-sm text-[var(--fg-muted)]">
            {brief.watchouts.map((watchout, i) => (
              <li key={i}>{watchout}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
