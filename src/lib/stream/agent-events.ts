export type AgentWireEvent =
  | { type: "token"; delta: string }
  | {
      type: "tool_start";
      id: string;
      toolName: string;
      argsSummary: string;
    }
  | {
      type: "tool_end";
      id: string;
      toolName: string;
      ok: boolean;
      summary: string;
    }
  | { type: "agent"; name: string }
  | { type: "final"; payload: unknown | null; renderer: string }
  | { type: "error"; message: string }
  | { type: "done"; messageId: string; agentId: string | null };
