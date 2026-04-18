import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL ?? "./data/newscraft.db";
const directory = dirname(databaseUrl);

if (!existsSync(directory)) {
  mkdirSync(directory, { recursive: true });
}

const sqlite = new Database(databaseUrl);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export { schema };
export type DB = typeof db;
