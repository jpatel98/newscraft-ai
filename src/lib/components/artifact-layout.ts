export type ArtifactPaneMode = 'side' | 'overlay';

/** Viewport width at which the artifact pane may share the row with the thread. */
export const ARTIFACT_SIDE_MIN_VIEWPORT = 1100;

/**
 * Side-by-side only when the viewport is wide enough that the thread keeps its
 * minimum readable width next to the open conversation drawer. Anything
 * narrower, or an unknown width (SSR, first paint), uses the overlay drawer so
 * the thread can never be squeezed by the pane.
 */
export function artifactPaneMode(viewportWidth: number | null | undefined): ArtifactPaneMode {
	if (typeof viewportWidth !== 'number' || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return 'overlay';
	return viewportWidth >= ARTIFACT_SIDE_MIN_VIEWPORT ? 'side' : 'overlay';
}
