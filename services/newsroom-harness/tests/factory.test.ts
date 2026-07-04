import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarnessRepository } from '../src/db/factory.js';
import { loadConfig } from '../src/config.js';

const {
	mirrorStartMock,
	mirrorCloseMock,
	MockPostgresHarnessMirror,
	MockPostgresMirroredHarnessRepository
} = vi.hoisted(() => {
	const mirrorStartMock = vi.fn().mockResolvedValue(undefined);
	const mirrorCloseMock = vi.fn().mockResolvedValue(undefined);

	class MockPostgresHarnessMirror {
		public db: unknown;
		public databaseUrl: string;
		start = mirrorStartMock;
		close = mirrorCloseMock;
		scheduleSync = vi.fn();
		deleteJob = vi.fn();

		constructor(db: unknown, databaseUrl: string) {
			this.db = db;
			this.databaseUrl = databaseUrl;
		}
	}

	class MockPostgresMirroredHarnessRepository {
		public ready: Promise<void>;

		constructor(
			public db: unknown,
			public mirror: MockPostgresHarnessMirror
		) {
			this.ready = mirror.start();
		}

		close = mirrorCloseMock;
	}

	return { mirrorStartMock, mirrorCloseMock, MockPostgresHarnessMirror, MockPostgresMirroredHarnessRepository };
});

vi.mock('../src/db/supabase-mirror.js', () => ({
	HARNESS_POSTGRES_TABLES: [],
	PostgresHarnessMirror: MockPostgresHarnessMirror,
	PostgresMirroredHarnessRepository: MockPostgresMirroredHarnessRepository,
	SupabaseHarnessMirror: MockPostgresHarnessMirror,
	SupabaseMirroredHarnessRepository: MockPostgresMirroredHarnessRepository
}));

describe('createHarnessRepository', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('uses sqlite backend when no harness db URL is configured', async () => {
		const config = { ...loadConfig(), databaseUrl: '', databaseMode: 'sqlite', dbPath: ':memory:' };
		const result = createHarnessRepository(config);

		expect(result.backend).toBe('sqlite');
		await result.ready;
		await result.repository.close();
	});

	it('uses postgres mirror backend when NEWSROOM_HARNESS_DATABASE_URL is configured', async () => {
		const config = {
			...loadConfig(),
			databaseUrl: 'postgres://harness-db.example/postgres',
			databaseMode: 'sqlite+postgres',
			dbPath: ':memory:'
		};
		const result = createHarnessRepository(config);

		await result.ready;
		expect(result.backend).toBe('sqlite+postgres');
		expect(mirrorStartMock).toHaveBeenCalledTimes(1);
		await result.repository.close();
		expect(mirrorCloseMock).toHaveBeenCalled();
	});
});
