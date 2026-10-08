import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATION_COUNT, MIGRATION_TABLE, MIGRATION_VERSIONS } from './migration-contract';
import { getMigrationStatus, missingMigrationStatus, type MigrationStatusClient } from './migration-status';

class StatusClient implements MigrationStatusClient {
	queries: string[] = [];

	constructor(private readonly versions: readonly string[], private readonly tableExists = true) {}

	async unsafe<T extends Record<string, unknown>[]>(query: string): Promise<T> {
		this.queries.push(query);
		if (query.includes('to_regclass')) {
			return [{ name: this.tableExists ? MIGRATION_TABLE : null }] as unknown as T;
		}
		return this.versions.map(version => ({ version })) as unknown as T;
	}
}

describe('application migration status', () => {
	it('reports complete only for the exact merged migration contract', async () => {
		const client = new StatusClient(MIGRATION_VERSIONS);
		expect(await getMigrationStatus(client)).toEqual({
			ok: true,
			table: MIGRATION_TABLE,
			tableExists: true,
			appliedCount: 20,
			latest: '0018_portable_agent_core',
			expectedCount: EXPECTED_MIGRATION_COUNT
		});
		expect(client.queries).toHaveLength(2);
		expect(client.queries.every(query => query.startsWith('SELECT '))).toBe(true);
	});

	it('reports the missing topic migration as incomplete', async () => {
		const client = new StatusClient(MIGRATION_VERSIONS.filter(version => version !== '0017_topic_projects'));
		expect(await getMigrationStatus(client)).toMatchObject({
			ok: false, tableExists: true, appliedCount: 19, error: 'Schema migrations are incomplete'
		});
	});

	it('does not let an unknown ledger row hide a missing required version', async () => {
		const client = new StatusClient([
			...MIGRATION_VERSIONS.filter(version => version !== '0017_topic_projects'),
			'0019_unrecognized'
		]);
		expect(await getMigrationStatus(client)).toMatchObject({ ok: false, tableExists: true, appliedCount: 20 });
	});

	it('rejects unknown extra versions even when every required version is present', async () => {
		const client = new StatusClient([...MIGRATION_VERSIONS, '0019_unrecognized']);
		expect(await getMigrationStatus(client)).toMatchObject({ ok: false, tableExists: true, appliedCount: 21 });
	});

	it('does not let duplicate rows stand in for a missing migration', async () => {
		const client = new StatusClient([
			...MIGRATION_VERSIONS.filter(version => version !== '0017_topic_projects'),
			MIGRATION_VERSIONS[0]
		]);
		expect(await getMigrationStatus(client)).toMatchObject({ ok: false, appliedCount: 20 });
	});

	it('returns the existing missing-table shape without querying an absent ledger', async () => {
		const client = new StatusClient([], false);
		expect(await getMigrationStatus(client)).toEqual(missingMigrationStatus('Migration table is not initialized'));
		expect(client.queries).toHaveLength(1);
	});

	it('reports an initialized empty ledger as incomplete', async () => {
		expect(await getMigrationStatus(new StatusClient([]))).toMatchObject({
			ok: false, tableExists: true, appliedCount: 0, latest: undefined
		});
	});

	it.each([1, 2])('sanitizes a database failure in query %s', async (failedQuery) => {
		const client = new StatusClient(MIGRATION_VERSIONS);
		const original = client.unsafe.bind(client);
		let queryCount = 0;
		client.unsafe = async (query) => {
			if (++queryCount === failedQuery) throw new Error('private connection details from database driver');
			return original(query);
		};
		const status = await getMigrationStatus(client);
		expect(status).toEqual(missingMigrationStatus('Migration status query failed'));
		expect(JSON.stringify(status)).not.toContain('private connection details');
	});
});
