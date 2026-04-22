import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { safeRedirectTarget } from "@/lib/server/auth-redirect";
import {
  GOOGLE_OAUTH_AUTHORIZE_URL,
  GOOGLE_OAUTH_STATE_COOKIE_NAME,
  GOOGLE_OAUTH_STATE_TTL_SECONDS,
  getGoogleClientSecret,
  getGoogleClientId,
  getGoogleRedirectUri,
  getGoogleOAuthScopes,
} from "@/lib/server/auth-identities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = safeRedirectTarget(url.searchParams.get("next"));
  const clientId = getGoogleClientId();
  const clientSecret = getGoogleClientSecret();

  if (!clientId || !clientSecret) {
    redirect(
      `/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent("Google sign-in is not configured.")}`,
    );
  }

  const state = randomBytes(12).toString("hex");
  const cookieStore = await cookies();
  cookieStore.set(GOOGLE_OAUTH_STATE_COOKIE_NAME, JSON.stringify({
    state,
    next,
    createdAt: Date.now(),
  }), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: GOOGLE_OAUTH_STATE_TTL_SECONDS,
  });

  const authUrl = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", getGoogleRedirectUri(request));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", getGoogleOAuthScopes());
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");
  authUrl.searchParams.set("access_type", "online");

  redirect(authUrl.toString());
}
