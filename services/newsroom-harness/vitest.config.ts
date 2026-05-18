import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node',
		testTimeout: 15_000
	},
	resolve: {
		alias: {
			'@newscraft/shared': new URL('../../packages/shared/src/index.ts', import.meta.url).pathname
		}
	}
});
