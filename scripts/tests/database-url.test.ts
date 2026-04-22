import assert from "node:assert/strict";
import test from "node:test";

import { resolveDatabaseTarget } from "../../src/db/database-url";

const originalVercel = process.env.VERCEL;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalTursoDatabaseUrl = process.env.TURSO_DATABASE_URL;
const originalTursoAuthToken = process.env.TURSO_AUTH_TOKEN;

test("resolveDatabaseTarget uses the local sqlite default outside Vercel", (context) => {
  context.after(() => {
    process.env.VERCEL = originalVercel;
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.TURSO_DATABASE_URL = originalTursoDatabaseUrl;
    process.env.TURSO_AUTH_TOKEN = originalTursoAuthToken;
  });

  delete process.env.VERCEL;
  delete process.env.DATABASE_URL;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;

  assert.deepEqual(resolveDatabaseTarget(), {
    databaseUrl: "file:./data/newscraft.db",
    authToken: undefined,
    localFilePath: "./data/newscraft.db",
  });
});

test("resolveDatabaseTarget rejects the local sqlite default on Vercel", (context) => {
  context.after(() => {
    process.env.VERCEL = originalVercel;
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.TURSO_DATABASE_URL = originalTursoDatabaseUrl;
    process.env.TURSO_AUTH_TOKEN = originalTursoAuthToken;
  });

  process.env.VERCEL = "1";
  delete process.env.DATABASE_URL;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;

  assert.throws(
    () => resolveDatabaseTarget(),
    /Use TURSO_DATABASE_URL and TURSO_AUTH_TOKEN|read-only except for \/tmp/,
  );
});

test("resolveDatabaseTarget allows an explicit non-default database url on Vercel", (context) => {
  context.after(() => {
    process.env.VERCEL = originalVercel;
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.TURSO_DATABASE_URL = originalTursoDatabaseUrl;
    process.env.TURSO_AUTH_TOKEN = originalTursoAuthToken;
  });

  process.env.VERCEL = "1";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.DATABASE_URL = "file:/tmp/newscraft.db";

  assert.deepEqual(resolveDatabaseTarget(), {
    databaseUrl: "file:/tmp/newscraft.db",
    authToken: undefined,
    localFilePath: "/tmp/newscraft.db",
  });
});

test("resolveDatabaseTarget prefers Turso env vars over local DATABASE_URL", (context) => {
  context.after(() => {
    process.env.VERCEL = originalVercel;
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.TURSO_DATABASE_URL = originalTursoDatabaseUrl;
    process.env.TURSO_AUTH_TOKEN = originalTursoAuthToken;
  });

  delete process.env.VERCEL;
  process.env.DATABASE_URL = "file:./data/newscraft.db";
  process.env.TURSO_DATABASE_URL = "libsql://newscraft-test.turso.io";
  process.env.TURSO_AUTH_TOKEN = "secret-token";

  assert.deepEqual(resolveDatabaseTarget(), {
    databaseUrl: "libsql://newscraft-test.turso.io",
    authToken: "secret-token",
    localFilePath: null,
  });
});

test("resolveDatabaseTarget requires a Turso auth token for remote Turso urls", (context) => {
  context.after(() => {
    process.env.VERCEL = originalVercel;
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.TURSO_DATABASE_URL = originalTursoDatabaseUrl;
    process.env.TURSO_AUTH_TOKEN = originalTursoAuthToken;
  });

  delete process.env.VERCEL;
  delete process.env.DATABASE_URL;
  process.env.TURSO_DATABASE_URL = "libsql://newscraft-test.turso.io";
  delete process.env.TURSO_AUTH_TOKEN;

  assert.throws(() => resolveDatabaseTarget(), /TURSO_AUTH_TOKEN is missing/);
});
