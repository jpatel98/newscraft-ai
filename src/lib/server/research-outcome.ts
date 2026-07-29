export type ResearchFinishStatus = 'completed' | 'partial' | 'failed' | 'cancelled';

export function resolveResearchFinishStatus(input: {
	requested: ResearchFinishStatus | undefined;
	researchRequired: boolean;
	sourceCount: number;
	citationCount: number;
}): ResearchFinishStatus | undefined {
	if (
		input.requested === 'completed' &&
		input.researchRequired &&
		input.sourceCount === 0 &&
		input.citationCount === 0
	) {
		return 'failed';
	}
	return input.requested;
}
