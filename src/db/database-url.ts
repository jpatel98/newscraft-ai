export type DatabaseTarget = {
  databaseUrl: string;
  authToken?: string;
  localFilePath: string | null;
};

type ResolveDatabaseTargetInput = {
  databaseUrl?: string;
  tursoDatabaseUrl?: string;
  tursoAuthToken?: string;
  vercel?: string;
};

const DEFAULT_LOCAL_DATABASE_PATH = "./data/newscraft.db";
const DEFAULT_LOCAL_DATABASE_URL = `file:${DEFAULT_LOCAL_DATABASE_PATH}`;

function isTruthyEnv(value: string | undefined) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

function isRemoteDatabaseUrl(databaseUrl: string) {
  return /^(libsql|https?|wss?):/i.test(databaseUrl);
}

function normalizeDatabaseUrl(rawDatabaseUrl: string | undefined) {
  const trimmed = rawDatabaseUrl?.trim();
  if (!trimmed) return DEFAULT_LOCAL_DATABASE_URL;
  if (trimmed === ":memory:" || trimmed.startsWith("file:")) return trimmed;
  if (isRemoteDatabaseUrl(trimmed)) return trimmed;
  return `file:${trimmed}`;
}

function getLocalFilePath(databaseUrl: string) {
  if (!databaseUrl.startsWith("file:")) return null;
  const path = databaseUrl.slice("file:".length);
  if (!path || path === ":memory:") return null;
  return path;
}

function isAllowedEphemeralVercelPath(localFilePath: string) {
  return localFilePath === "/tmp" || localFilePath.startsWith("/tmp/");
}

export function resolveDatabaseTarget(
  input: ResolveDatabaseTargetInput = {},
): DatabaseTarget {
  const rawTursoDatabaseUrl =
    input.tursoDatabaseUrl ?? process.env.TURSO_DATABASE_URL;
  const rawDatabaseUrl = input.databaseUrl ?? process.env.DATABASE_URL;
  const rawAuthToken = input.tursoAuthToken ?? process.env.TURSO_AUTH_TOKEN;
  const vercel = input.vercel ?? process.env.VERCEL;

  const isUsingTursoEnv = Boolean(rawTursoDatabaseUrl?.trim());
  const databaseUrl = normalizeDatabaseUrl(rawTursoDatabaseUrl ?? rawDatabaseUrl);
  const authToken = rawAuthToken?.trim() || undefined;
  const localFilePath = getLocalFilePath(databaseUrl);

  if (
    isUsingTursoEnv &&
    isRemoteDatabaseUrl(databaseUrl) &&
    typeof authToken === "undefined"
  ) {
    throw new Error(
      "TURSO_DATABASE_URL is set to a remote database, but TURSO_AUTH_TOKEN is missing.",
    );
  }

  if (
    isTruthyEnv(vercel) &&
    localFilePath &&
    !isAllowedEphemeralVercelPath(localFilePath)
  ) {
    throw new Error(
      [
        `Database URL ${databaseUrl} points at a local file path.`,
        "That works in local development, but not on Vercel Functions because the runtime filesystem is read-only except for /tmp scratch space.",
        "Use TURSO_DATABASE_URL and TURSO_AUTH_TOKEN for a persistent deployment, or explicitly set DATABASE_URL=file:/tmp/newscraft.db only for a non-persistent demo instance.",
      ].join(" "),
    );
  }

  return { databaseUrl, authToken, localFilePath };
}
