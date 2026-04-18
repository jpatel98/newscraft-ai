"use client";

import { Send, Square } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { AgentRow, ChannelRow } from "@/db/schema";
import { CommandPalette } from "./command-palette";

export type MessageComposerProps = {
  channelKind: ChannelRow["kind"];
  agent: AgentRow | null;
  streaming: boolean;
  onSend: (message: string) => void;
  onCancel: () => void;
};

export function MessageComposer({
  channelKind,
  agent,
  streaming,
  onSend,
  onCancel,
}: MessageComposerProps) {
  const [value, setValue] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setPaletteOpen(value.startsWith("/") && !value.includes(" "));
  }, [value]);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || streaming) return;
    setValue("");
    onSend(trimmed);
  }, [value, streaming, onSend]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    } else if (event.key === "Enter" && !event.shiftKey && !paletteOpen) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      setPaletteOpen(false);
    }
  };

  const selectCommand = (commandName: string) => {
    setValue(`${commandName} `);
    setPaletteOpen(false);
    textareaRef.current?.focus();
  };

  const placeholder =
    channelKind === "agent_dm" && agent
      ? `Message ${agent.name}… (try /help)`
      : "Message this channel… use /expert, /scan-site, or @mention an agent";

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg)] px-6 py-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <CommandPalette
          open={paletteOpen}
          query={value}
          onSelect={selectCommand}
        />

        <div className="relative flex items-end gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg)] p-2 focus-within:border-[var(--border-strong)] focus-within:ring-2 focus-within:ring-[var(--accent-link-soft)]">
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            placeholder={placeholder}
            className="max-h-48 min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-[0.9375rem] leading-6 outline-none placeholder:text-[var(--fg-subtle)]"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          {streaming ? (
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] text-[var(--fg-muted)] hover:border-[var(--border-strong)] hover:text-[var(--fg)]"
              onClick={onCancel}
              aria-label="Stop"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--fg)] text-[#fff] disabled:opacity-40"
              onClick={submit}
              disabled={!value.trim()}
              aria-label="Send"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between text-[0.7rem] text-[var(--fg-subtle)]">
          <span>
            <span className="wkbench-kbd">Enter</span> to send ·{" "}
            <span className="wkbench-kbd">Shift</span>+
            <span className="wkbench-kbd">Enter</span> for newline
          </span>
          <span>{streaming ? "Streaming…" : "Ready"}</span>
        </div>
      </div>
    </div>
  );
}
