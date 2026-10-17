import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// Story ledger evals: deterministic replays of recorded threads and red-team
// fixtures (judge verdicts come from a recorded cassette). `pnpm eval:ledger`.
export default defineConfig({
	plugins: [sveltekit()],
	test: {
		include: ['eval/**/*.eval.test.ts'],
		environment: 'node'
	}
});
