import type { HarnessConfig } from '../config.js';
import { openDatabase } from './database.js';
import { HarnessRepository } from './repository.js';
import {
	PostgresHarnessMirror,
	PostgresMirroredHarnessRepository
} from './supabase-mirror.js';

export interface HarnessRepositoryBundle {
	repository: HarnessRepository;
	ready: Promise<void>;
	backend: HarnessConfig['databaseMode'];
}

export function createHarnessRepository(config: HarnessConfig): HarnessRepositoryBundle {
	const db = openDatabase(config.dbPath);
	if (!config.databaseUrl) {
		return {
			repository: new HarnessRepository(db),
			ready: Promise.resolve(),
			backend: 'sqlite'
		};
	}
	const mirror = new PostgresHarnessMirror(db, config.databaseUrl);
	const repository = new PostgresMirroredHarnessRepository(db, mirror);
	return {
		repository,
		ready: repository.ready,
		backend: config.databaseMode
	};
}
