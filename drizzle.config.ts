import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { resolveDatabaseTarget } from "./src/db/database-url";

const { databaseUrl, authToken } = resolveDatabaseTarget();

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "turso",
  dbCredentials: {
    url: databaseUrl,
    authToken,
  },
});
