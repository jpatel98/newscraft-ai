import { mkdir } from 'node:fs/promises';

export default async function globalSetup() {
	await mkdir('.tmp/jig-181', { recursive: true, mode: 0o700 });
}
