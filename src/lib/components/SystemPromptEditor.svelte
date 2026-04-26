<script lang="ts">
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import X from 'lucide-svelte/icons/x';

	interface Props {
		conversationId: string;
		initial: string | null;
		open: boolean;
		onClose: () => void;
	}
	let { conversationId, initial, open, onClose }: Props = $props();

	const MAX = 8000;

	let value = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);
	let textarea = $state<HTMLTextAreaElement | null>(null);

	let prevId = '';
	let prevOpen = false;
	$effect(() => {
		if (open && (!prevOpen || conversationId !== prevId)) {
			value = initial ?? '';
			error = null;
			void tick().then(() => textarea?.focus());
		}
		prevOpen = open;
		prevId = conversationId;
	});

	const charCount = $derived(value.length);
	const overLimit = $derived(charCount > MAX);

	async function save() {
		if (saving || overLimit) return;
		const trimmed = value.trim();
		const payload = trimmed.length === 0 ? null : value;
		saving = true;
		error = null;
		try {
			const res = await fetch(`/api/conversations/${conversationId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ systemPrompt: payload })
			});
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				error = text || `save failed (${res.status})`;
				return;
			}
			await invalidateAll();
			onClose();
		} catch (e) {
			error = e instanceof Error ? e.message : 'save failed';
		} finally {
			saving = false;
		}
	}

	async function reset() {
		if (saving) return;
		value = '';
		saving = true;
		error = null;
		try {
			const res = await fetch(`/api/conversations/${conversationId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ systemPrompt: null })
			});
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				error = text || `reset failed (${res.status})`;
				return;
			}
			await invalidateAll();
			onClose();
		} catch (e) {
			error = e instanceof Error ? e.message : 'reset failed';
		} finally {
			saving = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		} else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
			e.preventDefault();
			void save();
		}
	}
</script>

<svelte:window onkeydown={onKey} />

{#if open}
	<button type="button" class="sp-backdrop" aria-label="Close editor" onclick={onClose}></button>
	<div class="sp-panel" role="dialog" aria-label="System prompt editor" aria-modal="true">
		<header class="sp-panel__head">
			<div>
				<div class="sp-panel__eyebrow">Thread</div>
				<h2 class="sp-panel__title">System prompt</h2>
			</div>
			<button type="button" class="sp-close" onclick={onClose} aria-label="Close">
				<X size="14" strokeWidth={1.5} />
			</button>
		</header>

		<div class="sp-panel__body">
			<label for="sp-textarea" class="sp-label">Override</label>
			<textarea
				id="sp-textarea"
				bind:this={textarea}
				bind:value
				class="sp-textarea"
				rows="14"
				maxlength={MAX + 200}
				placeholder="Leave empty to use the default. The override is injected as a leading system message on every turn in this thread."
				spellcheck="false"
			></textarea>
			<div class="sp-meta">
				<span class="sp-counter" class:sp-counter--over={overLimit}>{charCount} / {MAX}</span>
				{#if error}
					<span class="sp-error">{error}</span>
				{/if}
			</div>
		</div>

		<footer class="sp-panel__foot">
			<div class="sp-foot__note">Applies to new messages in this thread.</div>
			<div class="sp-foot__actions">
				<button
					type="button"
					class="sp-btn sp-btn--ghost"
					onclick={reset}
					disabled={saving || (initial ?? '').length === 0}
				>
					Reset to default
				</button>
				<button
					type="button"
					class="sp-btn sp-btn--primary"
					onclick={save}
					disabled={saving || overLimit}
				>
					{saving ? 'Saving…' : 'Save'}
				</button>
			</div>
		</footer>
	</div>
{/if}
