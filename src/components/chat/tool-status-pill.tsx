"use client";

import type { ToolEvent } from "@/lib/hooks/use-agent-stream";

export function ToolStatusPill({ event }: { event: ToolEvent }) {
  const state = event.ok === null ? "running" : event.ok ? "done" : "error";
  const label = describeToolLabel(event);

  return (
    <span className="wkbench-pill" data-state={state}>
      {state === "running" ? (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent-link)] animate-pulse" />
      ) : state === "error" ? (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--danger)]" />
      ) : (
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
      )}
      <span>{label}</span>
    </span>
  );
}

function describeToolLabel(event: ToolEvent): string {
  const verb = friendlyVerb(event.toolName, event.ok);
  const object = event.argsSummary || event.outputSummary;
  return object ? `${verb} ${truncate(object, 60)}` : verb;
}

function friendlyVerb(toolName: string, ok: boolean | null): string {
  const done = ok !== null;
  switch (toolName) {
    case "web_search_preview":
    case "web_search":
      return done ? "Searched the web" : "Searching the web";
    case "inspect_webpage":
      return done ? "Inspected" : "Inspecting";
    case "probe_site_directories":
      return done ? "Probed directories on" : "Probing directories on";
    default:
      return done ? `Ran ${toolName}` : `Running ${toolName}`;
  }
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
