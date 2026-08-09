import postgres from 'postgres';
import { runMigrations, type MigrationClient } from '../src/lib/server/db/migration-runner';

const databaseUrl = process.env.NEWSCRAFT_TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error('DATABASE_URL or NEWSCRAFT_TEST_DATABASE_URL is required for explicit migrations.');
}

const client = postgres(databaseUrl, { prepare: false, onnotice: () => {} });
try {
	const result = await runMigrations(client as unknown as MigrationClient, {
		appPasswordHash: process.env.APP_PASSWORD_HASH || undefined
	});
	console.log(
		JSON.stringify({
			latest: result.latest,
			applied: result.applied,
			baseline: result.baseline
		})
	);
} finally {
	await client.end({ timeout: 5 });
}
