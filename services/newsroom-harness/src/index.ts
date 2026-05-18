import { config as loadEnv } from 'dotenv';
import { createHarnessServer } from './server.js';

loadEnv({ path: '.env.local', override: false });
loadEnv({ path: '.env', override: false });

const harness = createHarnessServer();

harness.server.listen(harness.config.port, harness.config.host, () => {
	process.stdout.write(`newsroom-harness listening on ${harness.url()}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		void harness.close().finally(() => process.exit(0));
	});
}
