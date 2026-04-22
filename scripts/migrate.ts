import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveDatabaseTarget } from "../src/db/database-url";

async function main() {
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

  const db = drizzle(sqlite);
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  sqlite.close();
  console.log(`Applied migrations to ${databaseUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
