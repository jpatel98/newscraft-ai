import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import {
  createAuthSession,
  getActiveAuthSessionByTokenHash,
  revokeAuthSessionByTokenHash,
} from "@/db/queries/auth-sessions";

export const SESSION_COOKIE_NAME = "newscraft_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function makeSessionToken() {
  return randomBytes(32).toString("hex");
}

function buildCookieOptions() {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS,
  };
}

export async function createSessionForUser(userId: string) {
  const token = makeSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  await createAuthSession({ userId, tokenHash, expiresAt });
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, buildCookieOptions());
}

export async function clearSession() {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (rawToken) {
    await revokeAuthSessionByTokenHash(hashToken(rawToken));
  }
  cookieStore.delete(SESSION_COOKIE_NAME);
}

export async function getSessionUserId(): Promise<string | null> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return null;

  const session = await getActiveAuthSessionByTokenHash(hashToken(rawToken));
  if (!session) return null;

  return session.userId;
}
