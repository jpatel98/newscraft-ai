import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { safeRedirectTarget } from "@/lib/server/auth-redirect";
import {
  GOOGLE_OAUTH_STATE_COOKIE_NAME,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  getGoogleClientId,
  getGoogleClientSecret,
  getGoogleRedirectUri,
} from "@/lib/server/auth-identities";
import {
  isGoogleEmailVerified,
  parseGoogleState,
  readJsonSafe,
} from "@/lib/server/google-oauth";
import { createSessionForUser } from "@/lib/server/auth";
import { getDefaultTenantRouteForUser } from "@/lib/server/app-context";
import {
  createUser,
  ensureUserMembershipInFirstWorkspace,
  getUserByEmail,
} from "@/db/queries/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectToLogin(next: string, reason: string): never {
  redirect(
    `/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent(reason)}`,
  );
  throw new Error("Unreachable");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawCode = url.searchParams.get("code");
  const rawState = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");

  if (providerError) {
    redirectToLogin("/", `Google returned: ${providerError}`);
  }

  if (!rawCode || !rawState) {
    redirectToLogin("/", "OAuth flow was not completed.");
  }

  const cookieStore = await cookies();
  const oauthState = parseGoogleState(
    cookieStore.get(GOOGLE_OAUTH_STATE_COOKIE_NAME)?.value,
  );
  if (!oauthState || oauthState.state !== rawState) {
    redirectToLogin("/", "Invalid sign-in state.");
  }
  cookieStore.delete({
    name: GOOGLE_OAUTH_STATE_COOKIE_NAME,
    path: "/",
  });

  const safeNext = safeRedirectTarget(oauthState.next);
  const clientId = getGoogleClientId();
  const clientSecret = getGoogleClientSecret();
  if (!clientId || !clientSecret) {
    redirectToLogin(safeNext, "Google sign-in is not configured.");
  }

  let tokenJson: Record<string, unknown>;
  try {
    const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: rawCode,
        grant_type: "authorization_code",
        redirect_uri: getGoogleRedirectUri(request),
      }),
      cache: "no-store",
    });
    if (!tokenResponse.ok) {
      redirectToLogin(safeNext, "Could not exchange Google auth code.");
    }
    tokenJson = await readJsonSafe(tokenResponse, "Could not parse token response.");
  } catch {
    redirectToLogin(safeNext, "Could not exchange Google auth code.");
  }

  const accessTokenValue = tokenJson["access_token"];
  if (typeof accessTokenValue !== "string" || !accessTokenValue) {
    redirectToLogin(safeNext, "Google token exchange failed.");
  }
  const accessToken = accessTokenValue;

  let userInfo: Record<string, unknown>;
  try {
    const userInfoResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!userInfoResponse.ok) {
      redirectToLogin(safeNext, "Could not load Google account profile.");
    }
    userInfo = await readJsonSafe(userInfoResponse, "Could not parse Google profile.");
  } catch {
    redirectToLogin(safeNext, "Could not load Google account profile.");
  }

  const email =
    typeof userInfo.email === "string" ? userInfo.email.toLowerCase() : undefined;
  const emailVerifiedRaw = userInfo.email_verified;
  const emailVerified = isGoogleEmailVerified(
    typeof emailVerifiedRaw === "string" || typeof emailVerifiedRaw === "boolean"
      ? emailVerifiedRaw
      : undefined,
  );
  const displayName = userInfo.name;

  if (!email || !emailVerified || typeof email !== "string") {
    redirectToLogin(safeNext, "Google account email is missing or unverified.");
  }

  let user = await getUserByEmail(email);
  if (!user) {
    user = await createUser({
      email,
      name:
        typeof displayName === "string" && displayName.trim()
          ? displayName
          : email,
    });
  }

  if (!user) {
    redirectToLogin(safeNext, "Could not initialize your workspace account.");
  }

  const defaultWorkspace = await ensureUserMembershipInFirstWorkspace(user.id);
  if (!defaultWorkspace) {
    redirectToLogin(
      safeNext,
      "No workspace is available for this instance yet. Run setup and try again.",
    );
  }

  await createSessionForUser(user.id);

  if (safeNext === "/") {
    const tenantRoute = await getDefaultTenantRouteForUser(user.id);
    redirect(tenantRoute?.href ?? "/");
  }

  redirect(safeNext);
}
