"use client";

import { useCallback, useRef, useState } from "react";
import { previewRequestedRenderer } from "@/lib/chat-command-guidance";
import type { AgentWireEvent } from "@/lib/stream/agent-events";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  agentId: string | null;
  content: string;
  payload: unknown | null;
  renderer: string | null;
  createdAt: number;
};

export type ToolEvent = {
  id: string;
  toolName: string;
  argsSummary: string;
  ok: boolean | null;
  outputSummary: string;
};

export type PendingAssistant = {
  text: string;
  toolEvents: ToolEvent[];
  payload: unknown | null;
  expectedRenderer: string | null;
  renderer: string | null;
};

export type UseAgentStreamResult = {
  messages: ChatMessage[];
  pending: PendingAssistant | null;
  error: string | null;
  streaming: boolean;
  send: (message: string) => Promise<void>;
  cancel: () => void;
};

export function useAgentStream({
  channelId,
  initialMessages,
}: {
  channelId: string;
  initialMessages: ChatMessage[];
}): UseAgentStreamResult {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [pending, setPending] = useState<PendingAssistant | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStreaming(false);
  }, []);

  const send = useCallback(
    async (message: string) => {
      setError(null);
      const trimmed = message.trim();

      if (trimmed === "/clear") {
        try {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channelId, message: trimmed }),
          });

          if (!response.ok) {
            const errBody = (await response.json().catch(() => null)) as
              | { error?: string }
              | null;
            throw new Error(errBody?.error ?? `Request failed (${response.status})`);
          }

          setMessages([]);
          setPending(null);
        } catch (err) {
          if (err instanceof Error) {
            setError(err.message);
          }
        }
        return;
      }

      const controller = new AbortController();
      controllerRef.current = controller;
      setStreaming(true);

      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        agentId: null,
        content: trimmed,
        payload: null,
        renderer: null,
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, userMessage]);

      let accumulator: PendingAssistant = {
        text: "",
        toolEvents: [],
        payload: null,
        expectedRenderer: previewRequestedRenderer(trimmed),
        renderer: null,
      };
      setPending(accumulator);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelId, message: trimmed }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const errBody = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(errBody?.error ?? `Request failed (${response.status})`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const block of events) {
            const dataLine = block
              .split("\n")
              .find((line) => line.startsWith("data:"));
            if (!dataLine) continue;
            let wire: AgentWireEvent;
            try {
              wire = JSON.parse(dataLine.slice(5).trim()) as AgentWireEvent;
            } catch {
              continue;
            }

            switch (wire.type) {
              case "token":
                accumulator = {
                  ...accumulator,
                  text: accumulator.text + wire.delta,
                };
                setPending({ ...accumulator });
                break;
              case "tool_start":
                accumulator = {
                  ...accumulator,
                  toolEvents: [
                    ...accumulator.toolEvents,
                    {
                      id: wire.id,
                      toolName: wire.toolName,
                      argsSummary: wire.argsSummary,
                      ok: null,
                      outputSummary: "",
                    },
                  ],
                };
                setPending({ ...accumulator });
                break;
              case "tool_end":
                accumulator = {
                  ...accumulator,
                  toolEvents: accumulator.toolEvents.map((evt) =>
                    evt.id === wire.id
                      ? { ...evt, ok: wire.ok, outputSummary: wire.summary }
                      : evt,
                  ),
                };
                setPending({ ...accumulator });
                break;
              case "final":
                accumulator = {
                  ...accumulator,
                  payload: wire.payload,
                  renderer: wire.renderer,
                };
                setPending({ ...accumulator });
                break;
              case "error":
                setError(wire.message);
                setPending(null);
                break;
              case "done": {
                const committed: ChatMessage = {
                  id: wire.messageId,
                  role: "assistant",
                  agentId: wire.agentId ?? null,
                  content: accumulator.text,
                  payload: accumulator.payload,
                  renderer: accumulator.renderer,
                  createdAt: Date.now(),
                };
                setMessages((prev) => [...prev, committed]);
                setPending(null);
                break;
              }
              case "agent":
                break;
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          setError(err.message);
        }
        setPending(null);
      } finally {
        setStreaming(false);
        controllerRef.current = null;
      }
    },
    [channelId],
  );

  return { messages, pending, error, streaming, send, cancel };
}
