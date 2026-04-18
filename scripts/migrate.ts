import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const databaseUrl = process.env.DATABASE_URL ?? "./data/newscraft.db";
const directory = dirname(databaseUrl);

if (!existsSync(directory)) {
  mkdirSync(directory, { recursive: true });
}

const sqlite = new Database(databaseUrl);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const db = drizzle(sqlite);

migrate(db, { migrationsFolder: "./src/db/migrations" });

console.log(`Applied migrations to ${databaseUrl}`);
sqlite.close();
