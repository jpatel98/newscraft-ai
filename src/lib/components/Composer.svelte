<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import Send from 'lucide-svelte/icons/send-horizontal';
	import Paperclip from 'lucide-svelte/icons/paperclip';
	import X from 'lucide-svelte/icons/x';
	import { chat } from '$lib/stores/chat.svelte';
	import {
		resizeImage,
		MAX_TOTAL_BYTES,
		ImageTooLargeError,
		UnsupportedImageError,
		type ResizedImage
	} from '$lib/utils/image-resize';
	import type { ContentPart, MessageContent } from '$lib/types';

	interface Props {
		onSend?: (content: MessageContent) => Promise<void> | void;
		disabled?: boolean;
		placeholder?: string;
	}
	let { onSend, disabled = false, placeholder = 'Message NewsCraft' }: Props = $props();

	interface Attachment {
		id: string;
		name: string;
		state: 'compressing' | 'ready' | 'error';
		image?: ResizedImage;
		error?: string;
	}

	let value = $state('');
	let textarea: HTMLTextAreaElement | undefined = $state();
	let busy = $state(false);
	let fileInput: HTMLInputElement | undefined = $state();
	let attachments = $state<Attachment[]>([]);
	let dropActive = $state(false);
	let attachError = $state<string | null>(null);

	function autosize() {
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = textarea.scrollHeight + 'px';
	}

	$effect(() => {
		value;
		queueMicrotask(autosize);
	});

	onMount(() => {
		autosize();
	});

	$effect(() => {
		const recall = chat.editRequest;
		if (recall != null && !value) {
			value = recall;
			chat.consumeEdit();
			queueMicrotask(() => {
				textarea?.focus();
				autosize();
			});
		}
	});

	export function focus() {
		textarea?.focus();
	}

	export function setValue(next: string) {
		value = next;
		queueMicrotask(() => {
			textarea?.focus();
			autosize();
		});
	}

	function newAttachmentId(): string {
		return 'att-' + Math.random().toString(36).slice(2, 9);
	}

	async function ingestFiles(files: File[]) {
		attachError = null;
		const accepted = files.filter((f) => f.type.startsWith('image/'));
		const rejected = files.length - accepted.length;
		if (rejected > 0) attachError = 'Only image files are allowed.';

		for (const file of accepted) {
			const att: Attachment = {
				id: newAttachmentId(),
				name: file.name,
				state: 'compressing'
			};
			attachments = [...attachments, att];
			try {
				const image = await resizeImage(file);
				att.image = image;
				att.state = 'ready';
			} catch (e) {
				att.state = 'error';
				if (e instanceof UnsupportedImageError) att.error = 'not an image';
				else if (e instanceof ImageTooLargeError) att.error = 'too large after resize';
				else att.error = 'compress failed';
			}
			attachments = [...attachments];
		}
	}

	function onFilePick(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const files = input.files ? Array.from(input.files) : [];
		input.value = '';
		if (files.length) void ingestFiles(files);
	}

	function removeAttachment(id: string) {
		attachments = attachments.filter((a) => a.id !== id);
	}

	function onPaperclip() {
		fileInput?.click();
	}

	function onDragOver(e: DragEvent) {
		if (!e.dataTransfer) return;
		const hasFile = Array.from(e.dataTransfer.items).some((i) => i.kind === 'file');
		if (!hasFile) return;
		e.preventDefault();
		dropActive = true;
	}
	function onDragLeave() {
		dropActive = false;
	}
	function onDrop(e: DragEvent) {
		dropActive = false;
		if (!e.dataTransfer) return;
		const files = Array.from(e.dataTransfer.files);
		if (!files.length) return;
		e.preventDefault();
		void ingestFiles(files);
	}

	function buildContent(): MessageContent | null {
		const text = value.trim();
		const ready = attachments.filter((a) => a.state === 'ready' && a.image);
		if (!text && ready.length === 0) return null;
		if (ready.length === 0) return text;
		const parts: ContentPart[] = [];
		if (text) parts.push({ type: 'text', text });
		for (const a of ready) {
			parts.push({ type: 'image_url', image_url: { url: a.image!.dataUrl } });
		}
		return parts;
	}

	function totalBytes(content: MessageContent): number {
		if (typeof content === 'string') return new Blob([content]).size;
		let n = 0;
		for (const p of content) {
			if (p.type === 'text') n += new Blob([p.text]).size;
			else n += p.image_url.url.length;
		}
		return n;
	}

	async function send() {
		if (disabled) return;
		if (attachments.some((a) => a.state === 'compressing')) return;
		const content = buildContent();
		if (content == null) return;

		if (typeof content !== 'string' && totalBytes(content) > MAX_TOTAL_BYTES) {
			attachError = 'Attachments too large — remove one and try again.';
			return;
		}

		if (onSend) {
			value = '';
			attachments = [];
			attachError = null;
			void onSend(content);
			queueMicrotask(() => textarea?.focus());
			return;
		}
		if (busy) return;
		busy = true;
		try {
			const r = await fetch('/api/conversations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}'
			});
			if (!r.ok) throw new Error(`create-conv ${r.status}`);
			const { id } = (await r.json()) as { id: string };
			value = '';
			if (typeof content === 'string') {
				await goto(`/c/${id}#p=${encodeURIComponent(content)}`);
			} else {
				// Stash multimodal content for the destination page to pick up; the
				// hash-fragment handoff only carries strings.
				try {
					sessionStorage.setItem('hermes:pending:' + id, JSON.stringify(content));
				} catch {
					/* sessionStorage full or disabled — fall back to text only */
				}
				attachments = [];
				await goto(`/c/${id}#p=`);
			}
		} finally {
			busy = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
			return;
		}
		if (e.key === 'Escape' && document.activeElement === textarea) {
			textarea?.blur();
			e.preventDefault();
		}
	}

	const compressing = $derived(attachments.some((a) => a.state === 'compressing'));
	const canSend = $derived(
		!busy &&
			!disabled &&
			!compressing &&
			(value.trim().length > 0 || attachments.some((a) => a.state === 'ready'))
	);
	const showInterruptHint = $derived(chat.streaming && value.trim().length > 0);
</script>

<form
	onsubmit={(e) => {
		e.preventDefault();
		send();
	}}
>
	<input
		bind:this={fileInput}
		type="file"
		accept="image/*"
		multiple
		onchange={onFilePick}
		style="display:none"
		aria-hidden="true"
		tabindex="-1"
	/>
	<div
		class="composer-wrap"
		class:composer-wrap--drop={dropActive}
		ondragover={onDragOver}
		ondragleave={onDragLeave}
		ondrop={onDrop}
		role="presentation"
	>
		{#if attachments.length > 0}
			<div class="composer__attachments" aria-label="Attached images">
				{#each attachments as a (a.id)}
					<div
						class="composer__att"
						class:composer__att--error={a.state === 'error'}
						title={a.name}
					>
						{#if a.state === 'ready' && a.image}
							<img class="composer__att__thumb" src={a.image.dataUrl} alt={a.name} />
						{:else}
							<div class="composer__att__thumb composer__att__thumb--ph">
								{#if a.state === 'compressing'}compressing…{:else}error{/if}
							</div>
						{/if}
						<button
							type="button"
							class="composer__att__remove"
							onclick={() => removeAttachment(a.id)}
							aria-label="Remove {a.name}"
						>
							<X size="12" strokeWidth={2} />
						</button>
						<div class="composer__att__meta">
							{#if a.state === 'ready' && a.image}
								{Math.round(a.image.bytes / 1024)} KB
							{:else if a.state === 'error'}
								{a.error}
							{:else}
								…
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
		{#if attachError}
			<div class="composer__error" role="alert">{attachError}</div>
		{/if}
		<div class="composer" class:composer--busy={busy}>
			<button
				type="button"
				class="composer__icon-btn"
				onclick={onPaperclip}
				disabled={disabled || busy}
				aria-label="Attach image"
				title="Attach image"
			>
				<Paperclip size="16" strokeWidth={1.5} />
			</button>
			<textarea
				bind:this={textarea}
				bind:value
				onkeydown={onKey}
				class="composer__textarea"
				{placeholder}
				rows="1"
				disabled={busy}
				aria-label="Message NewsCraft"
			></textarea>
			<button
				type="submit"
				class="composer__send"
				disabled={!canSend}
				aria-label="Send message"
			>
				<Send size="14" strokeWidth={2} />
				<span>Send</span>
			</button>
		</div>
	</div>
	<div class="composer__hint" class:composer__hint--interrupt={showInterruptHint}>
		{#if showInterruptHint}
			<span><kbd>Enter</kbd> interrupts the current reply and sends</span>
		{:else}
			<span
				><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for newline · <kbd>Esc</kbd>
				to abort · <kbd>↑</kbd> to edit last</span
			>
		{/if}
	</div>
</form>

<style>
	.composer-wrap {
		position: relative;
	}
	.composer-wrap--drop::after {
		content: 'Drop image to attach';
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0;
		color: var(--cobalt-700);
		background: color-mix(in srgb, var(--cobalt-500) 8%, transparent);
		border: 1px dashed var(--cobalt-500);
		border-radius: var(--radius-2);
		pointer-events: none;
		z-index: 2;
	}
	.composer__attachments {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-bottom: 10px;
	}
	.composer__att {
		position: relative;
		width: 72px;
	}
	.composer__att__thumb {
		width: 72px;
		height: 72px;
		object-fit: cover;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-2);
		display: block;
		background: var(--bg-raised);
	}
	.composer__att__thumb--ph {
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: var(--font-mono);
		font-size: 9.5px;
		letter-spacing: 0;
		color: var(--fg-3);
		text-align: center;
		padding: 4px;
	}
	.composer__att--error .composer__att__thumb {
		border-color: var(--danger-fg, #b34040);
	}
	.composer__att__remove {
		position: absolute;
		top: -6px;
		right: -6px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		border: 1px solid var(--border-default);
		background: var(--bg-surface);
		color: var(--fg-2);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		padding: 0;
		transition:
			background var(--dur-fast) var(--ease-std),
			color var(--dur-fast) var(--ease-std),
			border-color var(--dur-fast) var(--ease-std);
	}
	.composer__att__remove:hover {
		color: var(--fg-1);
		background: var(--bg-raised);
		border-color: var(--border-strong);
	}
	.composer__att__remove:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus);
	}
	.composer__att__meta {
		margin-top: 4px;
		font-family: var(--font-mono);
		font-size: 9.5px;
		letter-spacing: 0;
		color: var(--fg-3);
		text-align: center;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.composer__error {
		margin-bottom: 8px;
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0;
		color: var(--danger-fg, #b34040);
	}
	.composer__hint--interrupt {
		color: var(--accent-fg);
	}
</style>
