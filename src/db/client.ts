import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";
import { resolveDatabaseTarget } from "./database-url";

const { databaseUrl, authToken, localFilePath } = resolveDatabaseTarget();

if (localFilePath) {
  const directory = dirname(localFilePath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
}

const sqlite = createClient({
  url: databaseUrl,
  authToken,
});

export const db = drizzle(sqlite, { schema });
export { schema };
export type DB = typeof db;
