export const DEFAULT_ADMIN_EMAIL = "admin@newscraft.local";
export const DEFAULT_GENERAL_EMAIL = "producer@newscraft.local";

export const GOOGLE_OAUTH_STATE_COOKIE_NAME = "newscraft_google_oauth_state";
export const GOOGLE_OAUTH_STATE_TTL_SECONDS = 60 * 5;
export const GOOGLE_OAUTH_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

export function getAdminEmail() {
  return process.env.NEWSCRAFT_ADMIN_USER_EMAIL ?? DEFAULT_ADMIN_EMAIL;
}

export function getGeneralEmail() {
  return process.env.NEWSCRAFT_GENERAL_USER_EMAIL ?? DEFAULT_GENERAL_EMAIL;
}

export function getAdminSigninToken() {
  return process.env.NEWSCRAFT_ADMIN_SIGNIN_TOKEN ?? "local-admin-link";
}

export function getGoogleClientId() {
  return process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
}

export function getGoogleClientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
}

export function getGoogleRedirectUri(request: Request) {
  const configured = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (configured) return configured;

  const origin = new URL(request.url).origin;
  return `${origin}/auth/google/callback`;
}

export function getGoogleOAuthScopes() {
  return process.env.GOOGLE_OAUTH_SCOPES?.trim() ?? "openid email profile";
}
