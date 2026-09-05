<script lang="ts">
	import Composer from '$lib/components/Composer.svelte';
import NewsroomArtifactPane, {
	type ArtifactDraft
} from '$lib/components/NewsroomArtifactPane.svelte';
import ArtifactCanvas from '$lib/components/ArtifactCanvas.svelte';
	import Thread from '$lib/components/Thread.svelte';
	import type { CitationRecord } from '@newscraft/shared';
	import type {
		PersistedSource,
		StreamPlanUpdate,
		StreamToolCall,
		StreamToolUpdate
	} from '$lib/utils/stream-events';
	import type { ChatCommand, ChatMessage, MessageContent } from '$lib/types';
	import { contentText } from '$lib/types';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { chat } from '$lib/stores/chat.svelte';
	import { onMount, tick, untrack } from 'svelte';
	import { formatThreadUpdated } from '$lib/utils/time';
	import { persistedThreadMessages, type PersistedThreadMessage } from '$lib/utils/thread-messages';
	import { parseSlashCommand } from '$lib/utils/slash';
	import {
		shouldReconnectDurableRun,
		streamFailureMessage,
		type StreamArgs
	} from '$lib/client/stream';
	import { subscribeDurableRun, type DurableRunSnapshot } from '$lib/client/stream';
	import {
		ConversationDocumentError,
		deleteConversationDocument,
		documentsCapabilityEnabled,
		uploadConversationPdf
	} from '$lib/client/documents';
	import type {
		AnswerUseAction,
		ComposerDocumentAttachment,
		DocumentUploadControls
	} from '$lib/components/journalist-ui';
	import { activeHTMLElement, focusDialog, restoreFocus, trapTabKey } from '$lib/utils/focus';
	import { selectConversationDisplayTitle } from '$lib/utils/conversation-title-display';
	import { SerialTaskQueue } from '$lib/utils/serial-task-queue';
	import {
		compareCursor,
		cursorOf as historyCursorOf,
		deriveHistoryGaps,
		MESSAGE_ID_BATCH_SIZE,
		initialTailSegment,
		mergeMessageRowsAtRevision,
		mergeTailRefresh,
		mergeSegments,
		reconcileMessageBatch,
		segmentsForExactMessages,
		segmentForMessages,
		type HistoryCursor,
		type HistoryGap,
		type HistoryPageMeta,
		type HistorySegment,
		type HistoryMessage
	} from '$lib/client/message-history';
	import {
		needsAutomaticConversationTitle,
		requestAutomaticConversationTitle
	} from '$lib/client/conversation-title';
import X from 'lucide-svelte/icons/x';
import Send from 'lucide-svelte/icons/send-horizontal';
import type { ArtifactDetail, ArtifactSummary } from '$lib/types/artifacts';

	type ThreadMessage = PersistedThreadMessage & { createdAt: number };
	type RunStreamArgs = StreamArgs & { conversation_id: string };
	type FailedSend = { args: RunStreamArgs };
	type DurableRunData = {
		id: string;
		conversationId: string;
		assistantMessageId: string;
		cursor: number;
		status: string;
		answerText: string;
		sources: PersistedSource[];
		citations: CitationRecord[];
		tools: StreamToolCall[];
		errorMessage: string | null;
	};

	const ANSWER_ACTION_REQUESTS: Record<AnswerUseAction, string> = {
		producer_brief: 'Create a producer brief from this answer.',
		thirty_second_script: 'Write a 30-second OC/VO from this answer.',
		interview_questions: 'Draft interview questions from this answer.',
		copy_with_citations: 'Turn this answer into clean copy with citations.'
	};

	let { data } = $props();

	// Per-stream overlay items keyed by their tmp ids. Each runStream pushes
	// its own user + assistant pair and removes them after invalidateAll picks
	// the persisted versions up. Using append-and-filter (not replace) so
	// concurrent or back-to-back runs don't trample each other.
	let overlay = $state<ThreadMessage[]>([]);
	let feedbackOpen = $state(false);
	let feedbackComment = $state('');
	let feedbackSaving = $state(false);
	let feedbackStatus = $state<string | null>(null);
	let feedbackError = $state<string | null>(null);
	let failedRetry = $state<FailedSend | null>(null);
	let feedbackDialog = $state<HTMLDivElement | null>(null);
	let feedbackTextarea = $state<HTMLTextAreaElement | null>(null);
	let feedbackOpener = $state<HTMLElement | null>(null);
	let documentsEnabled = $state(false);
	let documentAttachments = $state<ComposerDocumentAttachment[]>([]);
	let wasFeedbackOpen = false;
	// Persisted message ids that are currently being shadowed by an overlay
	// stream (resume). Hides the partial row while we re-stream into it; on
	// invalidateAll the partial flag flips and the row reappears finalized.
	let hiddenIds = $state<Set<string>>(new Set());
	let artifactOpen = $state(false);
	let activeArtifact = $state<ArtifactDraft | null>(null);
	let activeCanvasArtifact = $state<ArtifactDetail | null>(null);
	let activeRunId = $state<string | null>(null);
	let activeRunCursor = $state(0);
	let activeRunStatus = $state<string | null>(null);
	let activeConversationId = untrack(() => data.conversation.id);
	let automaticTitleRequestedFor: string | null = null;
	let automaticTitle = $state<string | null>(null);
	let conversationGeneration = 0;
	let historyMessages = $state<ThreadMessage[]>(
		untrack(() => [...(data.messages as ThreadMessage[])])
	);
	let historyMeta = $state<HistoryPageMeta>(
		untrack(() => ({
			pageSize: data.history.pageSize,
			totalCount: data.history.totalCount,
			hasOlder: data.history.hasOlder,
			hasNewer: data.history.hasNewer,
			olderCursor: data.history.olderCursor,
			newerCursor: data.history.newestCursor
		}))
	);
	let historySegments = $state<HistorySegment[]>([]);
	let historyLoading = $state(false);
	let historyError = $state<string | null>(null);
	let historyErrorGap = $state<HistoryGap | null>(null);
	let historyTargetStatus = $state<string | null>(null);
	let historyMutationVersion = $state(0);
	let historyMutationKind = $state<'prepend' | 'merge'>('merge');
	let historyTombstones = $state<Set<string>>(new Set());
	let historyAbortControllers = new Set<AbortController>();
	let historyRequestGeneration = 0;
	let historyMutationToken = 0;
	let historyRevisionSequence = 0;
	let historyRowRevisions = new Map<string, number>();
	let historyInitialized = false;
	let lastPageMessagesRef: unknown = null;
	let olderRequestActive = false;
	let gapRequests = $state<Set<string>>(new Set());
	let historyErrorTarget = $state<string | null>(null);

	const initialSegment = untrack(() => initialTailSegment(historyMessages, historyMeta.hasOlder));
	if (initialSegment) historySegments = [initialSegment];
	historyRowRevisions = new Map(untrack(() => historyMessages.map((message) => [message.id, 0])));

	const persisted = $derived(persistedThreadMessages(historyMessages, hiddenIds));
	const messages = $derived([...persisted, ...overlay]);
	const historyGaps = $derived(deriveHistoryGaps(historySegments));
	const sidebarConversationTitle = $derived(
		data.conversations.find((conversation) => conversation.id === data.conversation.id)?.title
	);
	const conversationTitle = $derived(
		selectConversationDisplayTitle(data.conversation.title, sidebarConversationTitle, automaticTitle)
	);

	const topic = $derived.by(() => {
		const n = Math.max(messages.length, historyMeta.totalCount ?? 0);
		if (n === 0) return '0 messages';
		return `${n} message${n === 1 ? '' : 's'} · Updated ${formatThreadUpdated(
			data.conversation.updatedAt
		)}`;
	});

	$effect(() => {
		const reversed = [...persisted].reverse();
		const lastUser = data.actionSummary.latestUser ?? reversed.find((m) => m.role === 'user');
		chat.lastUserContent = lastUser ? contentText(lastUser.content) : null;
		return () => {
			chat.lastUserContent = null;
		};
	});

	const streamQueue = new SerialTaskQueue();

	function clearFailureOverlays() {
		overlay = overlay.filter((m) => !m.failure);
	}

	type HistoryResponse = {
		mode: 'latest' | 'older' | 'range' | 'around' | 'ids';
		messages: ThreadMessage[];
		pageSize: number;
		totalCount?: number;
		hasOlder: boolean;
		hasNewer: boolean;
		olderCursor?: HistoryCursor | null;
		newerCursor?: HistoryCursor | null;
		gapBefore?: boolean;
		gapAfter?: boolean;
		hasMore?: boolean;
		nextAfter?: HistoryCursor | null;
		targetId?: string;
	};
	type HistoryFetch = { result: HistoryResponse; revision: number };

	class HistoryRequestError extends Error {
		readonly status: number;
		constructor(status: number) {
			super(`history ${status}`);
			this.name = 'HistoryRequestError';
			this.status = status;
		}
	}

	function encodeHistoryCursor(cursor: HistoryCursor): string {
		return btoa(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	function historyUrl(params: Record<string, string | number | undefined>): string {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) search.set(key, String(value));
		}
		const query = search.toString();
		return `/api/conversations/${encodeURIComponent(data.conversation.id)}/messages${query ? `?${query}` : ''}`;
	}

	function currentHashMessageId(): string | null {
		if (typeof location === 'undefined') return null;
		const match = location.hash.match(/^#m=(.+)$/);
		if (!match) return null;
		try {
			return decodeURIComponent(match[1]);
		} catch {
			return null;
		}
	}

	function clearTargetHash(targetId: string): void {
		if (typeof location === 'undefined' || currentHashMessageId() !== targetId) return;
		replaceState(location.pathname + location.search, {});
	}

	async function requestHistory(path: string): Promise<HistoryFetch> {
		const controller = new AbortController();
		const revision = ++historyRevisionSequence;
		historyAbortControllers.add(controller);
		try {
			const response = await fetch(path, { signal: controller.signal, headers: { accept: 'application/json' } });
			if (!response.ok) throw new HistoryRequestError(response.status);
			return { result: (await response.json()) as HistoryResponse, revision };
		} finally {
			historyAbortControllers.delete(controller);
		}
	}

	function historyRequestIsCurrent(generation: number, epoch: number, mutation: number): boolean {
		return (
			generation === conversationGeneration &&
			epoch === historyRequestGeneration &&
			mutation === historyMutationToken &&
			data.conversation.id === activeConversationId
		);
	}

	function rebaseHistorySegments(rows: ThreadMessage[]) {
		const rebased = historySegments
			.map((segment) => {
				const inSegment = rows.filter((message) => {
					const cursor = historyCursorOf(message);
					return compareCursor(cursor, segment.start) >= 0 && compareCursor(cursor, segment.end) <= 0;
				});
				return segmentForMessages(segment.id, inSegment, segment.hasBefore, segment.hasAfter);
			})
			.filter((segment): segment is HistorySegment => segment !== null);
		historySegments = mergeSegments(rebased);
	}

	function refreshTailSegment(pageMessages: ThreadMessage[], hasOlder: boolean) {
		historySegments = mergeTailRefresh(
			historySegments,
			pageMessages as HistoryMessage[],
			hasOlder
		);
	}

	function markHistoryMutation(ids: string[] = []) {
		historyMutationToken += 1;
		historyRequestGeneration += 1;
		if (ids.length) {
			const revision = ++historyRevisionSequence;
			const next = new Set(historyTombstones);
			const nextRevisions = new Map(historyRowRevisions);
			for (const id of ids) next.add(id);
			for (const id of ids) nextRevisions.set(id, revision);
			historyTombstones = next;
			historyRowRevisions = nextRevisions;
			historyMessages = historyMessages.filter((message) => !next.has(message.id));
			rebaseHistorySegments(historyMessages);
		}
	}

	async function loadMessageIds(ids: string[]): Promise<void> {
		const wanted = [...new Set(ids.filter(Boolean))];
		if (wanted.length === 0) return;
		const generation = conversationGeneration;
		const epoch = historyRequestGeneration;
		const mutation = historyMutationToken;
		try {
			for (let offset = 0; offset < wanted.length; offset += MESSAGE_ID_BATCH_SIZE) {
				const batch = wanted.slice(offset, offset + MESSAGE_ID_BATCH_SIZE);
				const { result, revision } = await requestHistory(historyUrl({ ids: batch.join(',') }));
				if (!historyRequestIsCurrent(generation, epoch, mutation)) return;
				if (result.messages.length) {
					const merged = mergeMessageRowsAtRevision(
						historyMessages as HistoryMessage[],
						result.messages as HistoryMessage[],
						historyTombstones,
						historyRowRevisions,
						revision
					);
					historyMessages = merged.messages as ThreadMessage[];
					historyRowRevisions = merged.revisions;
					historyMutationKind = 'merge';
					historyMutationVersion += 1;
					rebaseHistorySegments(historyMessages);
					const segments = segmentsForExactMessages(merged.accepted);
					if (segments.length) historySegments = mergeSegments([...historySegments, ...segments]);
				}
			}
		} catch {
			/* Keep the loaded history intact when a reconciliation request fails. */
		}
	}

	async function reconcileLoadedIds(generation: number, epoch: number, mutation: number) {
		const wanted = [...new Set(historyMessages.map((message) => message.id))];
		const baselineRevisions = new Map(
			wanted.map((id) => [id, historyRowRevisions.get(id) ?? 0])
		);
		for (let offset = 0; offset < wanted.length; offset += MESSAGE_ID_BATCH_SIZE) {
			const batch = wanted.slice(offset, offset + MESSAGE_ID_BATCH_SIZE);
			try {
				const { result, revision } = await requestHistory(historyUrl({ ids: batch.join(',') }));
				if (!historyRequestIsCurrent(generation, epoch, mutation)) return;
				const reconciled = reconcileMessageBatch(
					historyMessages as HistoryMessage[],
					result.messages as HistoryMessage[],
					batch,
					historyTombstones,
					historyRowRevisions,
					revision,
					baselineRevisions
				);
				historyMessages = reconciled.messages as ThreadMessage[];
				historyRowRevisions = reconciled.revisions;
				historyMutationKind = 'merge';
				historyMutationVersion += 1;
				rebaseHistorySegments(historyMessages);
			} catch {
				return;
			}
		}
		if (!historyRequestIsCurrent(generation, epoch, mutation)) return;
	}

	async function loadOlder() {
		if (olderRequestActive || historyLoading) return;
		const firstSegment = historySegments[0] ?? initialTailSegment(historyMessages, historyMeta.hasOlder);
		if (!firstSegment?.hasBefore) return;
		olderRequestActive = true;
		historyLoading = true;
		historyError = null;
		historyErrorGap = null;
		const generation = conversationGeneration;
		const epoch = historyRequestGeneration;
		const mutation = historyMutationToken;
		try {
			const { result, revision } = await requestHistory(
				historyUrl({ before: encodeHistoryCursor(firstSegment.start), limit: historyMeta.pageSize })
			);
			if (!historyRequestIsCurrent(generation, epoch, mutation)) return;
			if (result.messages.length) {
				const merged = mergeMessageRowsAtRevision(
					historyMessages as HistoryMessage[],
					result.messages as HistoryMessage[],
					historyTombstones,
					historyRowRevisions,
					revision
				);
				historyMessages = merged.messages as ThreadMessage[];
				historyRowRevisions = merged.revisions;
				historyMutationKind = 'prepend';
				historyMutationVersion += 1;
				const segment = segmentForMessages(
					`older:${merged.accepted[0]?.id ?? result.messages[0].id}`,
					merged.accepted,
					result.gapBefore ?? result.hasOlder,
					result.gapAfter ?? false
				);
				if (segment) historySegments = mergeSegments([...historySegments, segment]);
				historyMeta = {
					...historyMeta,
					hasOlder: result.gapBefore ?? result.hasOlder,
					olderCursor: result.olderCursor ?? historyMeta.olderCursor
				};
			} else {
				historySegments = historySegments.map((segment, index) =>
					index === 0 ? { ...segment, hasBefore: false } : segment
				);
				historyMeta = { ...historyMeta, hasOlder: false };
			}
		} catch {
			if (!historyRequestIsCurrent(generation, epoch, mutation)) return;
			historyError = "Couldn't load older messages. Try again.";
			historyErrorGap = null;
		} finally {
			if (generation === conversationGeneration) {
				historyLoading = false;
				olderRequestActive = false;
			}
		}
	}

	function closeHistoryGap(gap: HistoryGap) {
		historySegments = historySegments.map((segment) => {
			if (compareCursor(segment.end, gap.after) === 0) return { ...segment, hasAfter: false };
			if (compareCursor(segment.start, gap.before) === 0) return { ...segment, hasBefore: false };
			return segment;
		});
	}

	async function loadGap(gap: HistoryGap) {
		if (gapRequests.has(gap.id)) return;
		gapRequests = new Set([...gapRequests, gap.id]);
		historyError = null;
		historyErrorGap = null;
		const generation = conversationGeneration;
		const epoch = historyRequestGeneration;
		const mutation = historyMutationToken;
		try {
			const { result, revision } = await requestHistory(
				historyUrl({
					after: encodeHistoryCursor(gap.after),
					before: encodeHistoryCursor(gap.before),
					limit: historyMeta.pageSize
				})
			);
			if (!historyRequestIsCurrent(generation, epoch, mutation)) return;
			if (result.messages.length) {
				const merged = mergeMessageRowsAtRevision(
					historyMessages as HistoryMessage[],
					result.messages as HistoryMessage[],
					historyTombstones,
					historyRowRevisions,
					revision
				);
				historyMessages = merged.messages as ThreadMessage[];
				historyRowRevisions = merged.revisions;
				historyMutationKind = 'merge';
				historyMutationVersion += 1;
				const segment = segmentForMessages(
					`gap:${gap.id}`,
					merged.accepted,
					false,
					result.hasMore === true
				);
				if (segment) historySegments = mergeSegments([...historySegments, segment]);
			} else if (!result.hasMore) {
				closeHistoryGap(gap);
			}
		} catch {
			if (!historyRequestIsCurrent(generation, epoch, mutation)) return;
			historyError = "Couldn't load the missing messages. Try again.";
			historyErrorGap = gap;
		} finally {
			gapRequests = new Set([...gapRequests].filter((id) => id !== gap.id));
		}
	}

	async function loadAroundTarget(targetId: string) {
		if (!targetId || historyMessages.some((message) => message.id === targetId)) {
			if (targetId) historyTargetStatus = null;
			return;
		}
		historyTargetStatus = null;
		historyError = null;
		historyErrorTarget = null;
		const generation = conversationGeneration;
		const epoch = historyRequestGeneration;
		const mutation = historyMutationToken;
		try {
			const { result, revision } = await requestHistory(historyUrl({ around: targetId, before_count: 25, after_count: 25 }));
			if (!historyRequestIsCurrent(generation, epoch, mutation)) return;
			if (!result.messages.some((message) => message.id === targetId)) {
				historyTargetStatus = 'That message is no longer available.';
				clearTargetHash(targetId);
				return;
			}
			const merged = mergeMessageRowsAtRevision(
				historyMessages as HistoryMessage[],
				result.messages as HistoryMessage[],
				historyTombstones,
				historyRowRevisions,
				revision
			);
			historyMessages = merged.messages as ThreadMessage[];
			historyRowRevisions = merged.revisions;
			historyMutationKind = 'merge';
			historyMutationVersion += 1;
			const segment = segmentForMessages(
				`target:${targetId}`,
				merged.accepted,
				result.gapBefore ?? result.hasOlder,
				result.gapAfter ?? result.hasNewer
			);
			if (segment) historySegments = mergeSegments([...historySegments, segment]);
			await tick();
			document.getElementById(`m-${targetId}`)?.scrollIntoView({ block: 'center' });
		} catch (cause) {
			if (!historyRequestIsCurrent(generation, epoch, mutation)) return;
			if (cause instanceof HistoryRequestError && cause.status === 404) {
				historyTargetStatus = 'That message is no longer available.';
				clearTargetHash(targetId);
				return;
			}
			historyError = "Couldn't load that message. Try again.";
			historyErrorTarget = targetId;
		}
	}

	function loadHashTarget(): void {
		const targetId = currentHashMessageId();
		if (targetId && !historyMessages.some((message) => message.id === targetId)) {
			void loadAroundTarget(targetId);
		}
	}

	function retryHistory(): Promise<void> {
		if (historyErrorTarget) {
			const targetId = historyErrorTarget;
			historyErrorTarget = null;
			return loadAroundTarget(targetId);
		}
		return historyErrorGap ? loadGap(historyErrorGap) : loadOlder();
	}

	function resetHistoryFromPageData() {
		historyMessages = [...(data.messages as ThreadMessage[])];
		historyMeta = {
			pageSize: data.history.pageSize,
			totalCount: data.history.totalCount,
			hasOlder: data.history.hasOlder,
			hasNewer: data.history.hasNewer,
			olderCursor: data.history.olderCursor,
			newerCursor: data.history.newestCursor
		};
		const tail = initialTailSegment(historyMessages, historyMeta.hasOlder, 'tail');
		historySegments = tail ? [tail] : [];
		historyTombstones = new Set();
		historyRowRevisions = new Map(historyMessages.map((message) => [message.id, 0]));
		historyError = null;
		historyErrorGap = null;
		historyTargetStatus = null;
		historyErrorTarget = null;
		gapRequests = new Set();
	}

	$effect(() => {
		const pageConversationId = data.conversation.id;
		const pageMessages = data.messages;
		if (pageConversationId !== activeConversationId) return;
		if (lastPageMessagesRef === null) {
			lastPageMessagesRef = pageMessages;
			historyInitialized = true;
			return;
		}
		if (pageMessages === lastPageMessagesRef) return;
		lastPageMessagesRef = pageMessages;
		historyRequestGeneration += 1;
		historyMeta = {
			...historyMeta,
			pageSize: data.history.pageSize,
			totalCount: data.history.totalCount,
			hasOlder: data.history.hasOlder,
			olderCursor: data.history.olderCursor,
			newerCursor: data.history.newestCursor
		};
		const pageRevision = ++historyRevisionSequence;
		const merged = mergeMessageRowsAtRevision(
			historyMessages as HistoryMessage[],
			pageMessages as HistoryMessage[],
			historyTombstones,
			historyRowRevisions,
			pageRevision
		);
		historyMessages = merged.messages as ThreadMessage[];
		historyRowRevisions = merged.revisions;
		historyMutationKind = 'merge';
		historyMutationVersion += 1;
		refreshTailSegment(pageMessages as ThreadMessage[], data.history.hasOlder);
		if (historyInitialized) {
			void reconcileLoadedIds(conversationGeneration, historyRequestGeneration, historyMutationToken);
		}
		historyInitialized = true;
	});

	async function requestFirstPromptTitle(conversationId: string) {
		if (
			automaticTitleRequestedFor === conversationId ||
			!needsAutomaticConversationTitle(data.conversation.title)
		) {
			return;
		}
		automaticTitleRequestedFor = conversationId;
		try {
			const title = await requestAutomaticConversationTitle(
				conversationId,
				data.conversation.title
			);
			if (!title || conversationId !== activeConversationId) return;
			// Keep the generated title local while this run is active. Reloading the
			// page here would merge the newly persisted turn with its optimistic
			// overlay and render both copies. The stream finalizer already reloads
			// the page after it removes the overlay.
			automaticTitle = title;
		} catch (err) {
			console.warn('NewsCraft automatic title request failed', err);
		}
	}

	async function executeStream(
		args: RunStreamArgs,
		artifact?: { action: AnswerUseAction; sourceMessageId: string },
		existingRun?: DurableRunData
	) {
		const conversationId = args.conversation_id;
		const controller = chat.startStream(args.conversation_id);

		const requestArgs: RunStreamArgs = existingRun
			? args
			: {
					...args,
					idempotency_key:
						args.idempotency_key ||
						(typeof crypto !== 'undefined' && 'randomUUID' in crypto
							? crypto.randomUUID()
							: `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`)
				};
		const isResume = requestArgs.resume === true && !!requestArgs.message_id;
		const isRetry = requestArgs.retry === true;
		const attachedRun = existingRun != null;
		const isRetryableSend = Boolean(
			(requestArgs.content || requestArgs.output_action) && !requestArgs.regenerate && !isResume
		);
		if (isRetryableSend) clearFailureOverlays();
		const resumingId = attachedRun
			? existingRun.assistantMessageId
			: isResume
				? (requestArgs.message_id as string)
				: null;

		const userMsg: ThreadMessage | null =
			attachedRun || requestArgs.regenerate || isRetry || isResume
				? null
				: {
						id: 'tmp-u-' + Math.random().toString(36).slice(2),
						role: 'user',
						content: requestArgs.content ?? '',
						partial: false,
						createdAt: Date.now()
					};

		// Resume: seed the overlay with the partial's existing content so
		// streaming visually continues from where it left off, and hide the
		// persisted row so we don't double-render it.
		const seedContent = attachedRun
			? existingRun.answerText
			: isResume
			? (() => {
					const src = historyMessages.find((m) => m.id === resumingId);
					if (!src) return '';
					return contentText(src.content);
				})()
			: '';
		let asstMsg: ThreadMessage = {
			id: 'tmp-a-' + Math.random().toString(36).slice(2),
			role: 'assistant',
			content: seedContent,
			partial: true,
			streaming: true,
			createdAt: Date.now()
		};
		let localRunId = existingRun?.id ?? null;
		let cancelRequested = false;
		let cancelAccepted = false;
		let cancelInFlight = false;
		let cancelRetryTimer: ReturnType<typeof setTimeout> | null = null;
		const updateAssistantOverlay = (patch: Partial<ThreadMessage>) => {
			asstMsg = { ...asstMsg, ...patch };
			overlay = overlay.map((message) => (message.id === asstMsg.id ? asstMsg : message));
		};
		const clearCancelRetry = () => {
			if (cancelRetryTimer) clearTimeout(cancelRetryTimer);
			cancelRetryTimer = null;
		};
		const submitDurableCancel = async () => {
			if (!cancelRequested || cancelAccepted || cancelInFlight || !localRunId) return;
			const runId = localRunId;
			cancelInFlight = true;
			try {
				const response = await fetch(`/api/chat/runs/${encodeURIComponent(runId)}/cancel`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' }
				});
				if (!response.ok) throw new Error(`cancel ${response.status}`);
				cancelAccepted = true;
			} catch {
				if (cancelRequested && localRunId === runId) {
					clearCancelRetry();
					cancelRetryTimer = setTimeout(() => void submitDurableCancel(), 1_000);
				}
			} finally {
				cancelInFlight = false;
			}
		};
		const durableCancelHandler = () => {
			cancelRequested = true;
			activeRunStatus = 'cancel_requested';
			updateAssistantOverlay({ durableState: 'cancel_requested' });
			void submitDurableCancel();
			return false;
		};
		chat.setCancelHandler(durableCancelHandler);
		let asstText = seedContent;
		let streamEstablished = false;
		let partialAnswer = false;
		let runCompleted = false;
		let reconnectAttempts = 0;
		activeRunId = existingRun?.id ?? null;
		activeRunCursor = existingRun?.cursor ?? 0;
		activeRunStatus = existingRun?.status ?? null;
		let keepFailureAssistant = false;
		let failureToRethrow: unknown = null;
		let artifactCitations: CitationRecord[] = [];
		if (artifact) {
			activeArtifact = {
				...artifact,
				content: '',
				citations: [],
				status: 'generating'
			};
			artifactOpen = true;
		}
		const updateArtifact = (patch: Partial<ArtifactDraft>) => {
			if (
				!artifact ||
				activeArtifact?.action !== artifact.action ||
				activeArtifact.sourceMessageId !== artifact.sourceMessageId
			)
				return;
			activeArtifact = { ...activeArtifact, ...patch };
		};
		const noteStreamEstablished = () => {
			streamEstablished = true;
		};

		overlay = [...overlay, ...(userMsg ? [userMsg] : []), asstMsg];
		if (resumingId) {
			hiddenIds = new Set([...hiddenIds, resumingId]);
		}

		const run = (async () => {
			try {
				const { streamChat } = await import('$lib/client/stream');
				const callbacks = {
					signal: controller.signal,
					onMeta: (meta: { conversation_id: string; run_id?: string }) => {
						noteStreamEstablished();
						void requestFirstPromptTitle(meta.conversation_id);
						if (meta.run_id) {
							localRunId = meta.run_id;
							activeRunId = localRunId;
							if (cancelRequested) void submitDurableCancel();
						}
					},
					onRunCursor: (cursor: number) => {
						activeRunCursor = Math.max(activeRunCursor, cursor);
					},
					onRunSnapshot: (snapshot: DurableRunSnapshot) => {
						noteStreamEstablished();
						localRunId = snapshot.run_id;
						activeRunId = localRunId;
						activeRunCursor = snapshot.cursor;
						activeRunStatus = snapshot.status || snapshot.state;
						if (cancelRequested) void submitDurableCancel();
						updateAssistantOverlay({ durableState: activeRunStatus });
						if (snapshot.answerText !== asstText) {
							asstText = snapshot.answerText;
							updateAssistantOverlay({ content: asstText });
						}
						if (snapshot.citations.length) {
							chat.setCitations(snapshot.citations);
							artifactCitations = snapshot.citations;
						}
						for (const source of snapshot.sources) {
							chat.pushSource({
								...source,
								domain: source.domain || source.url,
								updatedAt: Date.now()
							});
						}
						for (const tool of snapshot.tools) chat.pushTool(tool);
				},
				onRunState: (state: string) => {
					noteStreamEstablished();
					activeRunStatus = state;
					const terminal = state === 'complete' || state === 'cancelled' || state === 'failed';
					if (state === 'cancel_requested') cancelAccepted = true;
					if (terminal) {
						cancelRequested = false;
						clearCancelRetry();
					}
					updateAssistantOverlay({
						durableState: state,
						...(terminal
							? { partial: state !== 'complete', streaming: false }
							: {})
					});
				},
				onDelta: (s: string) => {
						noteStreamEstablished();
						chat.noteAssistantOutput(s);
						asstText += s;
						updateAssistantOverlay({ content: asstText });
						updateArtifact({ content: asstText });
					},
				onReplace: (content: string) => {
						noteStreamEstablished();
						chat.noteAssistantOutput(content);
						asstText = content;
						updateAssistantOverlay({ content: asstText });
						updateArtifact({ content: asstText });
					},
				onToolProgress: (t: StreamToolUpdate) => {
						noteStreamEstablished();
						chat.pushTool(t);
					},
				onToolDone: (id: string, tool?: StreamToolUpdate) => {
						noteStreamEstablished();
						chat.clearTool(id, tool);
					},
				onSource: (source: PersistedSource) => {
						noteStreamEstablished();
						chat.pushSource({
							...source,
							domain: source.domain || source.url,
							updatedAt: Date.now()
						});
					},
				onCitations: (citations: CitationRecord[]) => {
						noteStreamEstablished();
						chat.setCitations(citations);
						artifactCitations = citations;
						updateArtifact({ citations });
					},
					onArtifactReady: (ready: ArtifactSummary) => {
						noteStreamEstablished();
						const existing = asstMsg.artifacts ?? [];
						updateAssistantOverlay({
							artifacts: [...existing.filter((item) => item.id !== ready.id), ready]
						});
					},
					onPlan: (plan: StreamPlanUpdate) => {
						noteStreamEstablished();
						chat.setPlan(plan);
					},
				onPartial: () => {
					noteStreamEstablished();
					partialAnswer = true;
				}
				};
				const connect = async () => {
					if (!attachedRun && !activeRunId) {
						await streamChat(requestArgs, callbacks);
					} else {
						await subscribeDurableRun(activeRunId as string, activeRunCursor, callbacks);
					}
					runCompleted = true;
				};
				while (!runCompleted) {
					try {
						await connect();
					} catch (cause) {
						if (controller.signal.aborted) throw cause;
						if (!shouldReconnectDurableRun(cause)) throw cause;
						reconnectAttempts += 1;
						activeRunStatus = 'reconnecting';
						updateAssistantOverlay({ durableState: 'reconnecting' });
						const reconnectDelay = Math.min(500 * 2 ** Math.min(reconnectAttempts - 1, 4), 5_000);
						await new Promise<void>((resolve) => setTimeout(resolve, reconnectDelay));
					}
				}
				if (isRetryableSend) failedRetry = null;
				updateAssistantOverlay({ partial: partialAnswer, streaming: false });
				updateArtifact({ content: asstText, citations: artifactCitations, status: 'ready' });
			} catch (e) {
				const aborted = (e as { name?: string })?.name === 'AbortError' || controller.signal.aborted;
				const wantsPartialAnswer = aborted && chat.abortIntent === 'partial';
				updateAssistantOverlay({ partial: false, streaming: false });
				if (wantsPartialAnswer && asstText.trim() === seedContent.trim()) {
					const note =
						'I stopped the source run before the agent produced a usable answer. No partial answer was available yet.';
					asstText = seedContent ? `${seedContent}\n\n${note}` : note;
					updateAssistantOverlay({ content: asstText });
					try {
						await fetch(`/api/conversations/${conversationId}/assistant-note`, {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ content: note })
						});
					} catch {
						/* the local overlay still tells the user what happened */
					}
				} else if (!aborted && activeRunStatus !== 'failed') {
					const message = streamFailureMessage(e);
					asstText = asstText.trim() ? `${asstText}\n\n${message}` : message;
					updateAssistantOverlay({ content: asstText });
					if (isRetryableSend) {
						updateAssistantOverlay({ failure: { retryable: true } });
						failedRetry = {
							args: {
								...requestArgs,
								document_ids: args.document_ids ? [...args.document_ids] : undefined
							}
						};
					}
					keepFailureAssistant = true;
					if (isRetryableSend && !streamEstablished) failureToRethrow = e;
				}
				if (artifact) updateArtifact({ content: asstText, citations: artifactCitations, status: 'error' });
			} finally {
					clearCancelRetry();
					chat.clearCancelHandler(durableCancelHandler);
					// Release the composer before any best-effort reload. A failed or
					// stalled invalidation must never strand the browser in active mode.
					if (chat.abort === controller) chat.endStream();
					try {
						await invalidateAll();
				} catch {
					/* ignore */
				}
				// Drop only this run's items from the overlay (other runs may have
				// added their own).
				const ids = new Set([...(userMsg ? [userMsg.id] : [])]);
				if (!keepFailureAssistant) ids.add(asstMsg.id);
				overlay = overlay.filter((m) => !ids.has(m.id));
				if (resumingId) {
					const next = new Set(hiddenIds);
					next.delete(resumingId);
					hiddenIds = next;
				}
				if (failureToRethrow) throw failureToRethrow;
			}
		})();
		return run;
	}

	async function runStream(
		args: RunStreamArgs,
		artifact?: { action: AnswerUseAction; sourceMessageId: string },
		existingRun?: DurableRunData
	) {
		const generation = conversationGeneration;
		await streamQueue.enqueue(async () => {
			if (generation !== conversationGeneration || args.conversation_id !== activeConversationId) return;
			await executeStream(args, artifact, existingRun);
		});
	}

	async function handleSend(
		content: MessageContent,
		command?: ChatCommand,
		documentIds: string[] = []
	) {
		const parsedCommand = typeof content === 'string' ? parseSlashCommand(content) : null;
		if (command?.slash === '/feedback' || parsedCommand?.slash === '/feedback') {
			feedbackComment = (command?.raw ?? parsedCommand?.raw ?? '').replace(/^\/feedback\b/i, '').trim();
			feedbackStatus = null;
			feedbackError = null;
			feedbackOpen = true;
			return;
		}
		if (chat.streaming) chat.cancel();
		await runStream({
			conversation_id: data.conversation.id,
			content,
			command,
			...(documentIds.length ? { document_ids: documentIds } : {})
		});
	}

	async function handleUseAnswer(action: AnswerUseAction, messageId: string) {
		await runStream(
			{
				conversation_id: data.conversation.id,
				content: ANSWER_ACTION_REQUESTS[action],
				output_action: action,
				source_message_id: messageId
			},
			{ action, sourceMessageId: messageId }
		);
	}

	async function openArtifact(summary: ArtifactSummary) {
		try {
			const response = await fetch(
				`/api/conversations/${encodeURIComponent(data.conversation.id)}/artifacts/${encodeURIComponent(summary.id)}?revision_id=${encodeURIComponent(summary.revisionId)}`,
				{ headers: { accept: 'application/json' } }
			);
			if (!response.ok) throw new Error(`artifact ${response.status}`);
			const payload = (await response.json()) as { artifact?: ArtifactDetail };
			if (!payload.artifact) throw new Error('artifact detail missing');
			activeCanvasArtifact = payload.artifact;
		} catch {
			activeCanvasArtifact = {
				...summary,
				spec: { kind: 'markdown', title: summary.title, markdown: summary.error?.message ?? 'This artifact could not be loaded.' },
				assets: []
			};
		}
	}

	async function handleDocumentUpload(file: File, controls: DocumentUploadControls) {
		try {
			const document = await uploadConversationPdf(data.conversation.id, file, {
				onCreated: (created) =>
					controls.update({ documentId: created.id, state: 'uploading' }),
				onProcessing: (processing) =>
					controls.update({ documentId: processing.id, state: 'processing' })
			});
			return {
				documentId: document.id,
				state: 'ready' as const,
				pageCount: document.pageCount ?? undefined,
				error: undefined
			};
		} catch (cause) {
			return {
				state: 'failed' as const,
				error:
					cause instanceof ConversationDocumentError
						? cause.message
						: "Couldn't process that PDF. Try again."
			};
		}
	}

	async function handleDocumentRemove(document: ComposerDocumentAttachment) {
		if (!document.documentId) return;
		await deleteConversationDocument(data.conversation.id, document.documentId);
	}

	async function submitFeedback() {
		const comment = feedbackComment.trim();
		if (!comment) {
			feedbackError = 'Add a comment before saving feedback.';
			return;
		}
		feedbackSaving = true;
		feedbackError = null;
		feedbackStatus = null;
		try {
			const response = await fetch(`/api/conversations/${data.conversation.id}/feedback`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ comment })
			});
			if (!response.ok) throw new Error(`feedback ${response.status}`);
			const result = (await response.json()) as { messageCount: number };
			feedbackStatus = `Captured ${result.messageCount} message${result.messageCount === 1 ? '' : 's'}.`;
			setTimeout(() => {
				if (feedbackStatus) feedbackOpen = false;
			}, 900);
		} catch {
			feedbackError = "Couldn't save feedback. Try again.";
		} finally {
			feedbackSaving = false;
		}
	}

	function closeFeedback() {
		if (feedbackSaving) return;
		feedbackOpen = false;
		feedbackStatus = null;
		feedbackError = null;
	}

	function onFeedbackKeydown(e: KeyboardEvent) {
		if (trapTabKey(e, feedbackDialog)) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			closeFeedback();
		}
	}

	async function handleRegenerate() {
		if (data.actionSummary.latestAssistantId) {
			markHistoryMutation([data.actionSummary.latestAssistantId]);
		}
		await runStream({ conversation_id: data.conversation.id, regenerate: true });
	}

	async function handleResume(messageId: string) {
		await runStream({
			conversation_id: data.conversation.id,
			resume: true,
			message_id: messageId
		});
	}

	async function handleRetryFailure() {
		const retry = failedRetry;
		if (!retry) return;
		clearFailureOverlays();
		failedRetry = null;
		try {
			const wanted = retry.args.content
				? contentText(retry.args.content)
				: retry.args.output_action
					? ANSWER_ACTION_REQUESTS[retry.args.output_action]
					: '';
			const summaryUser = data.actionSummary.latestUser;
			const summaryPartial = data.actionSummary.latestUnfinishedAssistantId;
			if (
				(summaryUser && !historyMessages.some((message) => message.id === summaryUser.id)) ||
				(summaryPartial && !historyMessages.some((message) => message.id === summaryPartial))
			) {
				await loadMessageIds(
					[
						summaryUser?.id,
						summaryPartial
					].filter((id): id is string => Boolean(id))
				);
			}
			const lastUserIndex = historyMessages.findLastIndex((message) => message.role === 'user');
			const lastUser = lastUserIndex >= 0 ? historyMessages[lastUserIndex] : summaryUser;
			const resumable =
				lastUser && wanted && contentText(lastUser.content) === wanted
					? historyMessages
							.slice(lastUserIndex + 1)
							.findLast((message) => message.role === 'assistant' && message.partial)
					: null;

			if (resumable) {
				await runStream({
					...retry.args,
					resume: true,
					message_id: resumable.id
				});
			} else if (lastUser && wanted && contentText(lastUser.content) === wanted) {
				await runStream({
					...retry.args,
					retry: true
				});
			} else {
				await runStream(retry.args);
			}
		} catch {
			/* runStream already leaves the safe retry state visible */
		}
	}

	async function handleRetryPersisted() {
		if (data.actionSummary.latestAssistantId) {
			markHistoryMutation([data.actionSummary.latestAssistantId]);
		}
		await runStream({
			conversation_id: data.conversation.id,
			retry: true
		});
	}

	async function handleDiscard(messageId: string) {
		const previousTombstones = historyTombstones;
		markHistoryMutation([messageId]);
		try {
			const claimResponse = await fetch(`/api/messages/${messageId}/claim-partial`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ conversation_id: data.conversation.id })
			});
			if (!claimResponse.ok) throw new Error('partial claim unavailable');
			const { claim_token: claimToken } = (await claimResponse.json()) as { claim_token?: number };
			if (!Number.isSafeInteger(claimToken)) throw new Error('partial claim token missing');
			const discardResponse = await fetch(`/api/messages/${messageId}/clear-partial`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ conversation_id: data.conversation.id, claim_token: claimToken })
			});
			if (!discardResponse.ok) throw new Error('partial discard failed');
		} catch {
			/* Restore the row when the compare-and-set discard did not commit. */
			historyMutationToken += 1;
			historyRequestGeneration += 1;
			historyTombstones = previousTombstones;
			await loadMessageIds([messageId]);
		}
		try {
			await invalidateAll();
		} catch {
			/* ignore */
		}
	}

	onMount(() => {
		const onHashChange = () => loadHashTarget();
		window.addEventListener('hashchange', onHashChange);
		void documentsCapabilityEnabled().then((enabled) => {
			documentsEnabled = enabled;
		});
		if (data.durableRun) {
			void runStream(
				{ conversation_id: data.conversation.id },
				undefined,
				data.durableRun as DurableRunData
			);
		}
		if (typeof location !== 'undefined') {
			const m = location.hash.match(/^#p=(.*)$/);
			if (m) {
				const stashKey = 'agent:pending:' + data.conversation.id;
				let stashed: MessageContent | null = null;
				try {
					const raw = sessionStorage.getItem(stashKey);
					if (raw) {
						sessionStorage.removeItem(stashKey);
						stashed = JSON.parse(raw) as MessageContent;
					}
				} catch {
					stashed = null;
				}
				let pending = '';
				try {
					pending = decodeURIComponent(m[1]);
				} catch {
					pending = '';
				}
				replaceState(location.pathname + location.search, {});
				if (stashed) void handleSend(stashed);
				else if (pending) void handleSend(pending);
			}
			loadHashTarget();
		}
		return () => {
			window.removeEventListener('hashchange', onHashChange);
			for (const controller of historyAbortControllers) controller.abort();
			historyAbortControllers.clear();
			chat.setCancelHandler(null);
			// Navigation or component destruction closes only this browser
			// subscription. It never calls the durable cancel route.
			if (chat.abort && !chat.abort.signal.aborted) chat.abort.abort();
		};
	});

	$effect(() => {
		const nextConversationId = data.conversation.id;
		if (nextConversationId === activeConversationId) return;
		activeConversationId = nextConversationId;
		automaticTitleRequestedFor = null;
		automaticTitle = null;
		conversationGeneration += 1;
		chat.setCancelHandler(null);
		if (chat.abort && !chat.abort.signal.aborted) chat.abort.abort();
		chat.endStream();
		overlay = [];
		hiddenIds = new Set();
		failedRetry = null;
		documentAttachments = [];
		feedbackOpen = false;
		activeRunId = null;
		activeRunCursor = 0;
		activeRunStatus = null;
		activeArtifact = null;
		activeCanvasArtifact = null;
		artifactOpen = false;
		for (const controller of historyAbortControllers) controller.abort();
		historyAbortControllers.clear();
		historyRequestGeneration += 1;
		lastPageMessagesRef = null;
		historyInitialized = false;
		resetHistoryFromPageData();
		const durableRun = data.durableRun as DurableRunData | null;
		if (durableRun) {
			void runStream({ conversation_id: nextConversationId }, undefined, durableRun);
		}
		loadHashTarget();
	});

	$effect(() => {
		if (feedbackOpen && !wasFeedbackOpen) {
			feedbackOpener = activeHTMLElement();
			void tick().then(() => {
				if (feedbackOpen) focusDialog(feedbackDialog, feedbackTextarea);
			});
		} else if (!feedbackOpen && wasFeedbackOpen) {
			const restoreTarget = feedbackOpener;
			feedbackOpener = null;
			void tick().then(() => restoreFocus(restoreTarget));
		}
		wasFeedbackOpen = feedbackOpen;
	});
</script>

<svelte:head>
	<title>{conversationTitle || 'Untitled thread'} · NewsCraft</title>
</svelte:head>

<header class="pane__header">
	<div>
		<div class="pane__header__title">
			{conversationTitle || 'Untitled thread'}
		</div>
		<div class="pane__header__topic">{topic}</div>
	</div>
</header>

<div class="conversation-workspace">
	{#key data.conversation.id}
		<Thread
			{messages}
			conversationId={data.conversation.id}
			history={{
				hasOlder: historySegments[0]?.hasBefore ?? historyMeta.hasOlder,
				loading: historyLoading,
				error: historyError,
				status: historyTargetStatus,
				gaps: historyGaps,
				loadingGapIds: [...gapRequests]
			}}
			historyMutation={{ kind: historyMutationKind, version: historyMutationVersion }}
			latestAssistantId={data.actionSummary.latestAssistantId}
			latestReadyAssistantId={data.actionSummary.latestReadyAssistantId}
			onLoadOlder={loadOlder}
			onLoadGap={loadGap}
			onRetryHistory={retryHistory}
			onRegenerate={handleRegenerate}
			onResume={handleResume}
			onDiscard={handleDiscard}
			onRetryFailure={handleRetryFailure}
			onRetryPersisted={handleRetryPersisted}
			onUseAnswer={handleUseAnswer}
			onOpenArtifact={openArtifact}
		/>
	{/key}
	{#if activeCanvasArtifact}
		<ArtifactCanvas
			artifact={activeCanvasArtifact}
			conversationId={data.conversation.id}
			onClose={() => (activeCanvasArtifact = null)}
		/>
	{/if}
	{#if artifactOpen && activeArtifact}
		<NewsroomArtifactPane
			draft={activeArtifact}
			disabled={chat.streaming}
			onSelect={handleUseAnswer}
			onClose={() => (artifactOpen = false)}
		/>
	{/if}
</div>

{#if feedbackOpen}
	<div class="feedback-backdrop">
		<button
			type="button"
			class="feedback-backdrop__dismiss"
			aria-label="Dismiss feedback"
			aria-hidden="true"
			tabindex="-1"
			onclick={closeFeedback}
			disabled={feedbackSaving}
		></button>
		<div
			bind:this={feedbackDialog}
			class="feedback-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="feedback-title"
			aria-describedby="feedback-desc"
			tabindex="-1"
			onkeydown={onFeedbackKeydown}
		>
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void submitFeedback();
			}}
		>
			<div class="feedback-dialog__head">
				<div>
					<div id="feedback-title" class="feedback-dialog__title">Capture feedback</div>
					<div id="feedback-desc" class="feedback-dialog__meta">
						{historyMeta.totalCount ?? messages.length} message{(historyMeta.totalCount ?? messages.length) === 1 ? '' : 's'} in this thread
					</div>
				</div>
				<button
					type="button"
					class="feedback-dialog__icon"
					aria-label="Close feedback"
					onclick={closeFeedback}
					disabled={feedbackSaving}
				>
					<X size="16" strokeWidth={1.8} />
				</button>
			</div>
			<textarea
				bind:this={feedbackTextarea}
				class="feedback-dialog__textarea"
				bind:value={feedbackComment}
				rows="5"
				maxlength="4000"
				placeholder="What should we know about this chat?"
				aria-label="Feedback comment"
				disabled={feedbackSaving}
			></textarea>
			{#if feedbackError}
				<div class="feedback-dialog__error" role="alert">{feedbackError}</div>
			{:else if feedbackStatus}
				<div class="feedback-dialog__status" role="status">{feedbackStatus}</div>
			{/if}
			<div class="feedback-dialog__actions">
				<button
					type="button"
					class="feedback-dialog__btn"
					onclick={closeFeedback}
					disabled={feedbackSaving}
				>
					Cancel
				</button>
				<button
					type="submit"
					class="feedback-dialog__btn feedback-dialog__btn--primary"
					disabled={feedbackSaving || !feedbackComment.trim()}
				>
					<Send size="14" strokeWidth={2} />
					<span>{feedbackSaving ? 'Saving' : 'Save feedback'}</span>
				</button>
			</div>
		</form>
		</div>
	</div>
{/if}

<div class="composer-zone">
	<div class="composer-zone__inner">
		<Composer
			onSend={handleSend}
			draftKey={data.conversation.id}
			{documentsEnabled}
			bind:documentAttachments
			onDocumentUpload={handleDocumentUpload}
			onDocumentRemove={handleDocumentRemove}
		/>
	</div>
</div>

<style>
	.conversation-workspace {
		flex: 1;
		min-height: 0;
		min-width: 0;
		display: flex;
	}
	.feedback-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: grid;
		place-items: center;
		padding: 20px;
		background: color-mix(in srgb, var(--ink-900) 28%, transparent);
	}
	.feedback-backdrop__dismiss {
		position: absolute;
		inset: 0;
		border: 0;
		background: transparent;
		padding: 0;
		cursor: default;
	}
	.feedback-dialog {
		position: relative;
		width: min(560px, 100%);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-2);
		background: var(--bg-surface);
		box-shadow: var(--shadow-2);
		padding: 16px;
		display: grid;
		gap: 12px;
	}
	.feedback-dialog__head {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: 12px;
	}
	.feedback-dialog__title {
		font-family: var(--font-display);
		font-size: 17px;
		font-weight: 650;
		letter-spacing: 0;
		color: var(--fg-1);
	}
	.feedback-dialog__meta {
		margin-top: 2px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--fg-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.feedback-dialog__icon {
		width: 32px;
		height: 32px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-1);
		background: var(--bg-surface);
		color: var(--fg-2);
		display: inline-grid;
		place-items: center;
		cursor: pointer;
	}
	.feedback-dialog__icon:hover:not(:disabled) {
		background: var(--bg-raised);
		color: var(--fg-1);
	}
	.feedback-dialog__icon:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.feedback-dialog__textarea {
		width: 100%;
		min-height: 120px;
		resize: vertical;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-2);
		background: var(--bg-page);
		color: var(--fg-1);
		font: inherit;
		font-size: 14px;
		line-height: 1.5;
		padding: 10px 12px;
		outline: none;
	}
	.feedback-dialog__textarea:focus {
		border-color: var(--border-strong);
		box-shadow: var(--shadow-focus);
	}
	.feedback-dialog__textarea::placeholder {
		color: var(--fg-4);
	}
	.feedback-dialog__error,
	.feedback-dialog__status {
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0;
	}
	.feedback-dialog__error {
		color: var(--danger-fg, #b34040);
	}
	.feedback-dialog__status {
		color: var(--cobalt-700);
	}
	.feedback-dialog__actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.feedback-dialog__btn {
		min-height: 34px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-1);
		background: var(--bg-surface);
		color: var(--fg-2);
		padding: 0 12px;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
	}
	.feedback-dialog__btn:hover:not(:disabled) {
		background: var(--bg-raised);
		color: var(--fg-1);
	}
	.feedback-dialog__btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.feedback-dialog__btn--primary {
		background: var(--ink-900);
		border-color: var(--ink-900);
		color: var(--ink-25);
	}
	.feedback-dialog__btn--primary:hover:not(:disabled) {
		background: var(--ink-700);
		border-color: var(--ink-700);
		color: var(--ink-25);
	}
	@media (max-width: 560px) {
		.feedback-backdrop {
			padding: 12px;
			align-items: end;
		}
		.feedback-dialog {
			max-width: 100%;
			width: 100%;
			max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 24px);
			overflow: auto;
		}
		.feedback-dialog__head {
			gap: 8px;
		}
		.feedback-dialog__btn {
			width: 100%;
		}
		.feedback-dialog__btn,
		.feedback-dialog__icon {
			min-height: 44px;
			height: 44px;
		}
		.feedback-dialog__btn--primary {
			min-height: 44px;
		}
		.feedback-dialog__textarea {
			font-size: 16px;
		}
	}
	@media (max-width: 620px) {
		.feedback-backdrop {
			align-items: end;
			padding: 12px;
		}
		.feedback-dialog__actions {
			display: grid;
			grid-template-columns: 1fr 1fr;
		}
		.feedback-dialog__btn {
			min-height: 44px;
		}
		.feedback-dialog__icon {
			min-width: 44px;
			width: 44px;
		}
	}
</style>
