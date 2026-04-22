import {
  GOOGLE_OAUTH_STATE_TTL_SECONDS,
} from "@/lib/server/auth-identities";

export const GOOGLE_OAUTH_STATE_MAX_AGE_MS =
  GOOGLE_OAUTH_STATE_TTL_SECONDS * 1000;

export type GoogleOAuthState = {
  state: string;
  next: string;
  createdAt: number;
};

export function parseGoogleState(raw: string | undefined): GoogleOAuthState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GoogleOAuthState;
    if (
      typeof parsed.state !== "string" ||
      typeof parsed.next !== "string" ||
      typeof parsed.createdAt !== "number"
    ) {
      return null;
    }
    if (Date.now() - parsed.createdAt > GOOGLE_OAUTH_STATE_MAX_AGE_MS) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function isGoogleEmailVerified(
  value: string | boolean | undefined,
): boolean {
  return value === true || `${value ?? ""}`.toLowerCase() === "true";
}

export async function readJsonSafe(
  response: Response,
  fallback: string,
): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return { error: fallback };
  }
}
