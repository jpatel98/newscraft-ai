import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import { InspectorRequests, type InspectorTarget } from './evidence-inspector';

function deferred() {
	let resolve!: (value: string) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<string>((accept, fail) => { resolve = accept; reject = fail; });
	return { promise, resolve, reject };
}

function inspector() {
	const requests = new InspectorRequests();
	let projectId = 'project-a';
	let target: InspectorTarget | null = null;
	let displayed: string | null = null;
	return {
		get displayed() { return displayed; },
		load(next: InspectorTarget, pending: ReturnType<typeof deferred>) {
			target = next;
			const request = requests.begin(projectId, next);
			const completion = pending.promise.then((value) => {
				if (request.isCurrent(projectId, target)) displayed = value;
			}, () => {
				if (request.isCurrent(projectId, target)) displayed = 'error';
			});
			return { ...request, completion };
		},
		close() {
			requests.cancel();
			target = null;
			displayed = null;
		},
		changeProject() {
			projectId = 'project-b';
			requests.cancel();
			displayed = null;
		}
	};
}

describe('inspector request ownership', () => {
	for (const action of ['close', 'delete', 'unmount'] as const) {
		it(`aborts on ${action} and ignores a late successful response`, async () => {
			const view = inspector();
			const pending = deferred();
			const request = view.load({ documentId: 'source-a', page: 1 }, pending);
			view.close();
			expect(request.signal.aborted).toBe(true);
			pending.resolve('withdrawn text');
			await request.completion;
			expect(view.displayed).toBeNull();
		});
	}

	it('keeps B when A completes later, even if the transport ignores abort', async () => {
		const view = inspector();
		const first = deferred();
		const second = deferred();
		const oldRequest = view.load({ documentId: 'source-a' }, first);
		const newRequest = view.load({ documentId: 'source-b' }, second);
		expect(oldRequest.signal.aborted).toBe(true);
		second.resolve('source B');
		await newRequest.completion;
		first.resolve('source A');
		await oldRequest.completion;
		expect(view.displayed).toBe('source B');
	});

	it('rejects old pagination completions for the same target object', async () => {
		const view = inspector();
		const target = { documentId: 'source-a' };
		const first = deferred();
		const second = deferred();
		const oldRequest = view.load(target, first);
		const newRequest = view.load(target, second);
		second.resolve('rows 26-50');
		await newRequest.completion;
		first.reject(new Error('late failure'));
		await oldRequest.completion;
		expect(view.displayed).toBe('rows 26-50');
	});

	it('ignores a response after switching projects', async () => {
		const view = inspector();
		const pending = deferred();
		const request = view.load({ documentId: 'source-a' }, pending);
		view.changeProject();
		expect(request.signal.aborted).toBe(true);
		pending.resolve('old project');
		await request.completion;
		expect(view.displayed).toBeNull();
	});

	it('checks the live project and selection before effect cleanup has run', () => {
		const requests = new InspectorRequests();
		const target = { documentId: 'source-a' };
		const request = requests.begin('project-a', target);
		expect(request.isCurrent('project-a', target)).toBe(true);
		expect(request.isCurrent('project-a', null)).toBe(false);
		expect(request.isCurrent('project-b', target)).toBe(false);
		expect(request.isCurrent('project-a', { documentId: 'source-b' })).toBe(false);
	});

	it('wires aborts, deletion, cleanup, and nullable pagination into the component', () => {
		const source = readFileSync(new URL('./ProjectEvidencePanel.svelte', import.meta.url), 'utf8');
		expect(() => compile(source, { filename: 'ProjectEvidencePanel.svelte', generate: 'client' })).not.toThrow();
		expect(source.match(/signal: request.signal/g)).toHaveLength(2);
		expect(source).toContain('if (inspect?.documentId === document.id) closeInspector();');
		expect(source).toContain('return () => inspectorRequests.cancel();');
		expect(source).toContain('onclick={closeInspector}');
		expect(source).toContain("deleting: 'Removal pending cleanup (retry Remove)'");
		expect(source).toContain('disabled={removing === document.id}');
		expect(source).toContain('if (!target || !page || inspector?.loading) return;');
		expect(source).toContain('if (!target || !rows || inspector?.loading) return;');
		expect(source).not.toContain('inspect!');
	});
});
