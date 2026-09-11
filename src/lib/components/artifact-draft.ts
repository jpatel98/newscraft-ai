import type { CitationRecord } from '@newscraft/shared';
import type { AnswerUseAction } from './journalist-ui';

export interface ArtifactDraft {
	action: AnswerUseAction;
	sourceMessageId: string;
	content: string;
	citations: CitationRecord[];
	status: 'generating' | 'ready' | 'error';
}
