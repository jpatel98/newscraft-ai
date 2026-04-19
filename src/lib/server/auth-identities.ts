export const DEFAULT_ADMIN_EMAIL = "admin@newscraft.local";
export const DEFAULT_GENERAL_EMAIL = "producer@newscraft.local";

export function getAdminEmail() {
  return process.env.NEWSCRAFT_ADMIN_USER_EMAIL ?? DEFAULT_ADMIN_EMAIL;
}

export function getGeneralEmail() {
  return process.env.NEWSCRAFT_GENERAL_USER_EMAIL ?? DEFAULT_GENERAL_EMAIL;
}

export function getAdminSigninToken() {
  return process.env.NEWSCRAFT_ADMIN_SIGNIN_TOKEN ?? "local-admin-link";
}

