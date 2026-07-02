import { createVercelHarnessHandler } from '../dist/serverless.js';

const harness = createVercelHarnessHandler();

export default async function handler(req, res) {
	await harness(req, res);
}
