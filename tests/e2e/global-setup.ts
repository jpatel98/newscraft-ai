import { rmSync } from 'node:fs';

export default async function globalSetup() {
	rmSync('.tmp/e2e', { recursive: true, force: true });
}
