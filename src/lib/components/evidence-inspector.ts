export interface InspectorTarget {
	documentId: string;
	page?: number;
	ordinals?: number[];
}

export class InspectorRequests {
	private request: AbortController | null = null;
	private identity = 0;

	begin(projectId: string, target: InspectorTarget) {
		this.cancel();
		const controller = new AbortController();
		const identity = this.identity;
		this.request = controller;
		return {
			signal: controller.signal,
			isCurrent: (currentProjectId: string, currentTarget: InspectorTarget | null) =>
				this.identity === identity && this.request === controller && !controller.signal.aborted &&
				currentProjectId === projectId && currentTarget === target
		};
	}

	cancel(): void {
		this.identity += 1;
		this.request?.abort();
		this.request = null;
	}
}
