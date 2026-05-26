import type { HarnessConfig } from '../config.js';
import { openDatabase } from './database.js';
import { HarnessRepository } from './repository.js';
import { SupabaseHarnessMirror, SupabaseMirroredHarnessRepository } from './supabase-mirror.js';

export interface HarnessRepositoryBundle {
	repository: HarnessRepository;
	ready: Promise<void>;
}

export function createHarnessRepository(config: HarnessConfig): HarnessRepositoryBundle {
	const db = openDatabase(config.dbPath);
	if (!config.databaseUrl) {
		return { repository: new HarnessRepository(db), ready: Promise.resolve() };
	}
	const mirror = new SupabaseHarnessMirror(db, config.databaseUrl);
	const repository = new SupabaseMirroredHarnessRepository(db, mirror);
	return { repository, ready: repository.ready };
}
