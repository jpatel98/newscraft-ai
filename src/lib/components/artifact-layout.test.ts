import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARTIFACT_SIDE_MIN_VIEWPORT, artifactPaneMode } from './artifact-layout';

function source(name: string): string {
	return readFileSync(new URL(name, import.meta.url), 'utf8');
}

describe('artifact pane layout mode', () => {
	it('shares the row only at 1100px and wider', () => {
		expect(ARTIFACT_SIDE_MIN_VIEWPORT).toBe(1100);
		expect(artifactPaneMode(1100)).toBe('side');
		expect(artifactPaneMode(1440)).toBe('side');
		expect(artifactPaneMode(1099)).toBe('overlay');
		expect(artifactPaneMode(780)).toBe('overlay');
		expect(artifactPaneMode(375)).toBe('overlay');
	});

	it('falls back to the overlay drawer when the width is unknown', () => {
		for (const width of [0, -1, NaN, Infinity, null, undefined]) expect(artifactPaneMode(width)).toBe('overlay');
	});
});

describe('artifact pane layout source', () => {
	it('protects the thread width and wraps long tokens', () => {
		const thread = source('./Thread.svelte');
		const css = readFileSync(new URL('../styles/components.css', import.meta.url), 'utf8');
		expect(thread).toContain('min-width: min(100%, 472px);');
		expect(css).toMatch(/\.msg__resume \{[^}]*overflow-wrap: anywhere;/);
		expect(css).toMatch(/\.msg__body \{[^}]*overflow-wrap: anywhere;/);
	});

	it('hosts the pane in a mode-driven slot with scrim and close control', () => {
		const page = readFileSync(new URL('../../routes/c/[id]/+page.svelte', import.meta.url), 'utf8');
		expect(page).toContain('bind:innerWidth={viewportWidth}');
		expect(page).toContain('artifactPaneMode(viewportWidth)');
		expect(page).toContain('class="artifact-scrim"');
		expect(page).toContain('flex: 0 1 520px;');
		expect(page).toMatch(/\.artifact-slot--overlay \{[^}]*position: fixed;/);
		expect(source('./NewsroomArtifactPane.svelte')).toContain('aria-label="Close artifact pane"');
		expect(source('./NewsroomArtifactPane.svelte')).not.toContain('min(430px, 40vw)');
		expect(source('./NewsroomArtifactPaneLoader.svelte')).not.toContain('min(430px,40vw)');
	});
});
