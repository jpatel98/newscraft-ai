import type { AgentWireEvent } from "./agent-events";

const encoder = new TextEncoder();

export function encodeSSE(event: AgentWireEvent): Uint8Array {
  const payload = JSON.stringify(event);
  return encoder.encode(`event: ${event.type}\ndata: ${payload}\n\n`);
}

export function encodePing(): Uint8Array {
  return encoder.encode(`: ping\n\n`);
}
