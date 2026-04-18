import { run, type Agent, type AgentOutputType } from "@openai/agents";
import { nanoid } from "nanoid";
import type { AgentWireEvent } from "./agent-events";

type EmitFn = (event: AgentWireEvent) => void;

type ToolCallRawItem = {
  id?: string;
  callId?: string;
  name?: string;
  arguments?: string | Record<string, unknown>;
  status?: string;
};

function summarizeArgs(raw: ToolCallRawItem): string {
  const args = raw.arguments;
  if (!args) return "";
  if (typeof args === "string") {
    try {
      return summarizeObject(JSON.parse(args));
    } catch {
      return args.slice(0, 120);
    }
  }
  return summarizeObject(args);
}

function summarizeObject(value: unknown): string {
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.url === "string") return obj.url;
    if (typeof obj.query === "string") return obj.query;
    if (typeof obj.input === "string") return obj.input;
    if (typeof obj.q === "string") return obj.q;
    const firstString = Object.values(obj).find(
      (candidate) => typeof candidate === "string",
    );
    if (typeof firstString === "string") return firstString.slice(0, 120);
  }
  return "";
}

function isToolCallItem(item: unknown): item is { rawItem: ToolCallRawItem } {
  return (
    typeof item === "object" &&
    item !== null &&
    "rawItem" in item &&
    typeof (item as { rawItem: unknown }).rawItem === "object"
  );
}

function extractCallId(raw: ToolCallRawItem): string {
  return raw.callId ?? raw.id ?? nanoid();
}

type ToolOutputRaw = {
  callId?: string;
  output?: unknown;
  status?: string;
  error?: unknown;
  name?: string;
};

export type RunAgentOptions = {
  agent: Agent<unknown, AgentOutputType>;
  prompt: string;
  previousResponseId?: string | null;
  signal?: AbortSignal;
  emit: EmitFn;
};

export type RunAgentResult = {
  finalOutput: unknown;
  lastResponseId: string | null;
  accumulatedText: string;
};

export async function runAgentWithStream({
  agent,
  prompt,
  previousResponseId,
  signal,
  emit,
}: RunAgentOptions): Promise<RunAgentResult> {
  const streamed = await run(agent, prompt, {
    stream: true,
    ...(previousResponseId ? { previousResponseId } : {}),
    ...(signal ? { signal } : {}),
  });

  let accumulatedText = "";

  for await (const event of streamed) {
    switch (event.type) {
      case "raw_model_stream_event": {
        const data = event.data as { type?: string; delta?: string };
        if (data?.type === "output_text_delta" && typeof data.delta === "string") {
          accumulatedText += data.delta;
          emit({ type: "token", delta: data.delta });
        }
        break;
      }
      case "run_item_stream_event": {
        const { name, item } = event;
        if (!isToolCallItem(item)) break;

        const raw = item.rawItem;

        if (name === "tool_called") {
          emit({
            type: "tool_start",
            id: extractCallId(raw),
            toolName: raw.name ?? "tool",
            argsSummary: summarizeArgs(raw),
          });
        } else if (name === "tool_output") {
          const outputRaw = raw as ToolOutputRaw;
          const ok = outputRaw.status !== "error" && !outputRaw.error;
          emit({
            type: "tool_end",
            id: extractCallId(raw),
            toolName: outputRaw.name ?? "tool",
            ok,
            summary: summarizeToolOutput(outputRaw.output),
          });
        } else if (name === "handoff_occurred") {
          // Handoff rendered via agent_updated below; no-op.
        }
        break;
      }
      case "agent_updated_stream_event": {
        emit({ type: "agent", name: event.agent.name });
        break;
      }
    }
  }

  return {
    finalOutput: streamed.finalOutput ?? null,
    lastResponseId: streamed.lastResponseId ?? null,
    accumulatedText,
  };
}

function summarizeToolOutput(output: unknown): string {
  if (!output) return "";
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      return summarizeToolOutput(parsed);
    } catch {
      return output.slice(0, 160);
    }
  }
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    if (obj.ok === false && typeof obj.error === "string") {
      return obj.error.slice(0, 160);
    }
    if (typeof obj.title === "string") return obj.title.slice(0, 160);
    if (typeof obj.url === "string") return obj.url;
    if (Array.isArray(obj.directories)) {
      return `${obj.directories.length} directory page${obj.directories.length === 1 ? "" : "s"}`;
    }
    if (Array.isArray(obj.likelyPeoplePages)) {
      return `${obj.likelyPeoplePages.length} people link${obj.likelyPeoplePages.length === 1 ? "" : "s"}`;
    }
  }
  return "";
}
