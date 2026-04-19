"use client";

import { useState, useTransition } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import type {
  AgentCommandDescriptor,
  AgentToolSpec,
} from "@/lib/agents/catalog";
import type { WorkspaceAgentRecord } from "@/db/queries/agents";
import { saveAgent } from "@/lib/actions/save-agent";
import {
  deleteNewsSource,
  saveNewsSource,
} from "@/lib/actions/save-news-source";

export type AgentSourceRecord = {
  id: string;
  url: string;
  label: string;
  kind: "rss" | "html";
};

export type AgentDescriptorForUI = {
  id: string;
  defaultName: string;
  availableTools: AgentToolSpec[];
  commands: AgentCommandDescriptor[];
  defaults: {
    instructions: string;
    enabledTools: string[];
  };
};

export type AgentConfigEditorProps = {
  descriptor: AgentDescriptorForUI;
  row: WorkspaceAgentRecord;
  sources?: AgentSourceRecord[];
};

export function AgentConfigEditor({
  descriptor,
  row,
  sources = [],
}: AgentConfigEditorProps) {
  const [name, setName] = useState(row.name);
  const [description, setDescription] = useState(row.description);
  const [instructions, setInstructions] = useState(row.instructions);
  const [model, setModel] = useState(row.model ?? "");
  const [enabledTools, setEnabledTools] = useState<Set<string>>(
    new Set(row.enabledTools ?? []),
  );
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [sourceKind, setSourceKind] = useState<"rss" | "html">("html");
  const [isPending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const toggleTool = (key: string) => {
    setEnabledTools((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const resetToDefaults = () => {
    setInstructions(descriptor.defaults.instructions);
    setEnabledTools(new Set(descriptor.defaults.enabledTools));
  };

  const submit = () => {
    startTransition(async () => {
      await saveAgent({
        id: row.id,
        name: name.trim() || descriptor.defaultName,
        description: description.trim(),
        instructions: instructions.trim(),
        model: model.trim() ? model.trim() : null,
        enabledTools: Array.from(enabledTools),
      });
      setSavedAt(Date.now());
    });
  };

  return (
    <>
      <header className="flex items-baseline gap-3 border-b border-[var(--border)] px-6 py-3">
        <h1 className="text-base font-semibold text-[var(--fg)]">
          {descriptor.defaultName}
        </h1>
        <span className="text-sm text-[var(--fg-muted)]">
          Edit how this agent thinks, what it can reach for, and how it shows up.
        </span>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
          <Section title="Identity">
            <Field label="Name">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Description" hint="Shown next to the agent in the sidebar.">
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className={inputClass}
              />
            </Field>
          </Section>

          <Section
            title="System prompt"
            hint="Admin-only runtime instructions. Producers do not see this in chat."
            right={
              <button
                type="button"
                onClick={resetToDefaults}
                className="text-xs text-[var(--accent-link)] hover:underline"
              >
                Reset to default
              </button>
            }
          >
            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={16}
              className={`${inputClass} font-mono text-[0.85rem] leading-6`}
            />
          </Section>

          <Section title="Model" hint="Overrides the default model for this agent only. Leave blank to fall back to OPENAI_MODEL.">
            <input
              value={model}
              placeholder={process.env.NEXT_PUBLIC_DEFAULT_MODEL_HINT ?? "e.g. gpt-5.4-mini"}
              onChange={(event) => setModel(event.target.value)}
              className={inputClass}
            />
          </Section>

          <Section title="Tools" hint="Only checked tools are passed to the agent at runtime.">
            <ul className="flex flex-col gap-2">
              {descriptor.availableTools.map((tool) => {
                const checked = enabledTools.has(tool.key);
                return (
                  <li
                    key={tool.key}
                    className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg-elevated)] p-3"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleTool(tool.key)}
                      className="mt-0.5 h-4 w-4 accent-[var(--accent-link)]"
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-[var(--fg)]">
                        {tool.name}
                      </div>
                      <div className="text-sm text-[var(--fg-muted)]">
                        {tool.description}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Section>

          {row.id === "news-monitor" ? (
            <Section
              title="Digest sources"
              hint="Manage the watchlist used by /digest. This lives in the database and updates live."
            >
              <div className="grid gap-3 md:grid-cols-[1.4fr_1fr_140px_auto]">
                <input
                  value={sourceUrl}
                  placeholder="https://example.com/news or feed URL"
                  onChange={(event) => setSourceUrl(event.target.value)}
                  className={inputClass}
                />
                <input
                  value={sourceLabel}
                  placeholder="Short label"
                  onChange={(event) => setSourceLabel(event.target.value)}
                  className={inputClass}
                />
                <select
                  value={sourceKind}
                  onChange={(event) =>
                    setSourceKind(event.target.value as "rss" | "html")
                  }
                  className={inputClass}
                >
                  <option value="html">HTML page</option>
                  <option value="rss">RSS feed</option>
                </select>
                <button
                  type="button"
                  onClick={() => {
                    startTransition(async () => {
                      await saveNewsSource({
                        url: sourceUrl,
                        label: sourceLabel,
                        kind: sourceKind,
                      });
                      setSourceUrl("");
                      setSourceLabel("");
                      setSourceKind("html");
                    });
                  }}
                  disabled={isPending || !sourceUrl.trim()}
                  className="inline-flex items-center justify-center gap-2 rounded-[var(--radius-sm)] bg-[var(--fg)] px-3 py-2 text-sm text-white disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add source
                </button>
              </div>

              {sources.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {sources.map((source) => (
                    <li
                      key={source.id}
                      className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg-elevated)] p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-[var(--fg)]">
                          {source.label}
                        </div>
                        <div className="truncate text-sm text-[var(--fg-muted)]">
                          {source.url}
                        </div>
                      </div>
                      <span className="wkbench-kbd">{source.kind}</span>
                      <button
                        type="button"
                        onClick={() => {
                          startTransition(async () => {
                            await deleteNewsSource(source.id);
                          });
                        }}
                        disabled={isPending}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] text-[var(--fg-muted)] hover:border-[var(--border-strong)] hover:text-[var(--danger)] disabled:opacity-50"
                        aria-label={`Remove ${source.label}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-sm text-[var(--fg-muted)]">
                  No sources configured yet.
                </div>
              )}
            </Section>
          ) : null}

          <Section title="Commands" hint="Shown in the /palette to summon this agent from any channel.">
            <ul className="flex flex-col gap-1.5 text-sm">
              {descriptor.commands.map((command) => (
                <li key={command.name}>
                  <code className="wkbench-kbd mr-2">{command.name}</code>
                  <span className="text-[var(--fg)]">{command.summary}</span>{" "}
                  <span className="text-[var(--fg-muted)]">
                    — {command.example}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>

      <div className="border-t border-[var(--border)] bg-[var(--bg)] px-6 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-end gap-3">
          {savedAt ? (
            <span className="text-xs text-[var(--fg-muted)]">Saved</span>
          ) : null}
          <button
            type="button"
            onClick={submit}
            disabled={isPending}
            className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--fg)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </>
  );
}

const inputClass =
  "w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[0.9375rem] outline-none focus:border-[var(--border-strong)] focus:ring-2 focus:ring-[var(--accent-link-soft)]";

function Section({
  title,
  right,
  hint,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="eyebrow text-[var(--fg-subtle)]">{title}</div>
        {right}
      </div>
      {hint ? (
        <p className="text-xs text-[var(--fg-muted)]">{hint}</p>
      ) : null}
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-[var(--fg-muted)]">{label}</span>
      {children}
      {hint ? (
        <span className="text-xs text-[var(--fg-muted)]">{hint}</span>
      ) : null}
    </label>
  );
}
