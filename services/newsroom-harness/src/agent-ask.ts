import { config as loadEnv } from 'dotenv';
import { DisciplinedNewsroomAgent } from './agents/newsroom-agent.js';
import { loadConfig } from './config.js';
import { createHarnessRepository } from './db/factory.js';

loadEnv({ path: '.env.local', override: false, quiet: true });
loadEnv({ path: '.env', override: false, quiet: true });
loadEnv({ path: '../../.env.local', override: false, quiet: true });
loadEnv({ path: '../../.env', override: false, quiet: true });

const prompt = process.argv.slice(2).join(' ').trim();

if (!prompt) {
	process.stderr.write('Usage: npm run agent:ask -- "Your newsroom request"\n');
	process.exit(1);
}

const config = loadConfig();
const { repository, ready } = createHarnessRepository(config);
await ready;
const agent = new DisciplinedNewsroomAgent({
	config: config.agent,
	repository,
	openAiApiKey: config.openAiApiKey
});

try {
	const result = await agent.run(prompt, {
		repository,
		openAiApiKey: config.openAiApiKey
	});
	process.stdout.write(`${result.final_answer.trim()}\n`);
} catch (err) {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exitCode = 1;
} finally {
	await repository.close();
}
