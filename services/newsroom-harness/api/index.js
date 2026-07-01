import { createHarnessServer } from '../dist/server.js';

const harness = createHarnessServer({ startScheduler: false });

export default async function handler(req, res) {
	await harness.ready;
	await harness.handle(req, res);
}
