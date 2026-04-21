"use client";

import type { CatalogCommand } from "@/lib/agents/commands-catalog";

export type CommandPaletteProps = {
  open: boolean;
  query: string;
  suggestions: CatalogCommand[];
  onSelect: (commandName: string) => void;
};

export function CommandPalette({
  open,
  query,
  suggestions,
  onSelect,
}: CommandPaletteProps) {
  if (!open) return null;

  if (suggestions.length === 0) return null;

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg-elevated)] p-1.5 shadow-[var(--shadow-sm)]">
      <div className="eyebrow px-2 pb-1 text-[var(--fg-subtle)]">Commands</div>
      <ul className="flex flex-col gap-0.5">
        {suggestions
          .filter((command) => command.name.toLowerCase().startsWith(query.toLowerCase()))
          .map((command) => (
            <li key={command.name}>
              <button
                type="button"
                className="flex w-full flex-col rounded-[var(--radius-sm)] px-2 py-1.5 text-left hover:bg-[var(--surface-hover)]"
                onClick={() => onSelect(command.name)}
              >
                <span className="font-mono text-sm">{command.name}</span>
                <span className="text-xs text-[var(--fg-muted)]">
                  {command.summary}
                </span>
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}
