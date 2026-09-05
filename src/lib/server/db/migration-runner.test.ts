import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATION_COUNT, MIGRATION_TABLE, MIGRATION_VERSIONS } from './migration-contract';
import { runMigrations, splitMigrationStatements, type MigrationClient } from './migration-runner';

class ConcurrentMigrationFakeClient implements MigrationClient {
	queries: string[] = [];
	maxConcurrentDdl = 0;
	private activeDdl = 0;
	private versions = new Set<string>();
	private advisoryTail = Promise.resolve();

	async unsafe<T = unknown>(query: string, values?: unknown[]): Promise<T> {
		const transaction = new MigrationTransaction(this);
		try {
			return await this.executeQuery(transaction, query, values);
		} finally {
			transaction.releaseAdvisoryLock();
		}
	}

	async begin<T>(callback: (transaction: MigrationClient) => Promise<T>): Promise<T> {
		const transaction = new MigrationTransaction(this);
		try {
			return await callback(transaction);
		} finally {
			transaction.releaseAdvisoryLock();
		}
	}

	async executeQuery<T>(transaction: MigrationTransaction, query: string, values?: unknown[]): Promise<T> {
		this.queries.push(query);
		if (query.includes('pg_advisory_xact_lock')) {
			const previous = this.advisoryTail;
			let release!: () => void;
			this.advisoryTail = new Promise<void>((resolve) => {
				release = resolve;
			});
			await previous;
			transaction.setAdvisoryRelease(release);
			return [] as T;
		}
		if (query.includes('SELECT version FROM')) {
			return [...this.versions].map((version) => ({ version })) as T;
		}
		if (query.includes('information_schema.tables') || query.includes('information_schema.columns')) {
			return [] as T;
		}
		if (query.includes(`INSERT INTO ${MIGRATION_TABLE}`)) {
			const version = values?.[0];
			if (typeof version === 'string') this.versions.add(version);
			return [] as T;
		}
		if (/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX)/i.test(query)) {
			this.activeDdl += 1;
			this.maxConcurrentDdl = Math.max(this.maxConcurrentDdl, this.activeDdl);
			await new Promise((resolve) => setTimeout(resolve, 0));
			this.activeDdl -= 1;
		}
		return [] as T;
	}

}

class MigrationTransaction implements MigrationClient {
	private advisoryRelease: (() => void) | undefined;

	constructor(private readonly root: ConcurrentMigrationFakeClient) {}

	unsafe<T = unknown>(query: string, values?: unknown[]): Promise<T> {
		return this.root.executeQuery(this, query, values);
	}

	begin<T>(callback: (transaction: MigrationClient) => Promise<T>): Promise<T> {
		return this.root.begin(callback);
	}

	setAdvisoryRelease(release: () => void): void {
		this.advisoryRelease = release;
	}

	releaseAdvisoryLock(): void {
		const release = this.advisoryRelease;
		this.advisoryRelease = undefined;
		release?.();
	}
}

describe('explicit Postgres migration runner', () => {
	it('splits generated migrations only at Drizzle breakpoints', () => {
		expect(splitMigrationStatements('CREATE TABLE a (id text);\n--> statement-breakpoint\nALTER TABLE a ADD COLUMN name text;')).toEqual([
			'CREATE TABLE a (id text);',
			'ALTER TABLE a ADD COLUMN name text;'
		]);
	});

	it('serializes concurrent bootstrap callers through one transaction boundary and advisory lock', async () => {
		const client = new ConcurrentMigrationFakeClient();
		const results = await Promise.all([runMigrations(client), runMigrations(client)]);

		expect(client.maxConcurrentDdl).toBe(1);
		expect(client.queries.filter((query) => query.includes('pg_advisory_xact_lock'))).toHaveLength(2);
		expect(client.queries.filter((query) => query.includes(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE}`))).toHaveLength(2);
		expect(results.every((result) => result.latest === MIGRATION_VERSIONS.at(-1))).toBe(true);
});
});

const isolatedDatabaseUrl = process.env.NEWSCRAFT_TEST_DATABASE_URL || '';
const isolatedClients: ReturnType<typeof postgres>[] = [];

afterAll(async () => {
		await Promise.all(isolatedClients.map((client) => client.end({ timeout: 1 })));
});

describe.skipIf(!isolatedDatabaseUrl)('explicit migration runner against an isolated Postgres test database', () => {
	it('allows two cold-start clients to converge without DDL races', async () => {
		const first = postgres(isolatedDatabaseUrl, { max: 1, prepare: false, onnotice: () => {} });
		const second = postgres(isolatedDatabaseUrl, { max: 1, prepare: false, onnotice: () => {} });
		isolatedClients.push(first, second);

		const [left, right] = await Promise.all([
			runMigrations(first as unknown as MigrationClient),
			runMigrations(second as unknown as MigrationClient)
		]);
		const [row] = await first.unsafe<Array<{ count: number }>>(
			`SELECT count(*)::int AS count FROM ${MIGRATION_TABLE}`
		);

		expect(left.latest).toBe(MIGRATION_VERSIONS.at(-1));
		expect(right.latest).toBe(MIGRATION_VERSIONS.at(-1));
		expect(Number(row?.count)).toBeGreaterThanOrEqual(EXPECTED_MIGRATION_COUNT);
	});
});
