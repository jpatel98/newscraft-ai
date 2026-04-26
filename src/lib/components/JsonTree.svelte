<script lang="ts">
	import Self from './JsonTree.svelte';

	interface Props {
		value: unknown;
		name?: string | number;
		depth?: number;
		root?: boolean;
	}
	let { value, name, depth = 0, root = true }: Props = $props();

	const STR_LIMIT = 140;

	let expanded = $state(false);
	let strExpanded = $state(false);
	let didInit = false;
	$effect(() => {
		if (didInit) return;
		didInit = true;
		expanded = depth < 1;
	});

	function kind(v: unknown): 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'undefined' {
		if (v === null) return 'null';
		if (Array.isArray(v)) return 'array';
		const t = typeof v;
		if (t === 'object' || t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') return t;
		return 'string';
	}

	const k = $derived(kind(value));
	const isContainer = $derived(k === 'object' || k === 'array');
	const containerSize = $derived.by(() => {
		if (k === 'array') return (value as unknown[]).length;
		if (k === 'object') return Object.keys(value as object).length;
		return 0;
	});
	const entries = $derived.by<Array<[string | number, unknown]>>(() => {
		if (k === 'array') return (value as unknown[]).map((v, i) => [i, v]);
		if (k === 'object') return Object.entries(value as object);
		return [];
	});

	const canToggle = $derived(isContainer && containerSize > 0);
	const isLongString = $derived(k === 'string' && (value as string).length > STR_LIMIT);
	const displayedString = $derived.by(() => {
		if (k !== 'string') return '';
		const s = value as string;
		if (!isLongString || strExpanded) return s;
		return s.slice(0, STR_LIMIT) + '…';
	});

	function toggle() {
		if (canToggle) expanded = !expanded;
	}
</script>

<div class="jt-row" class:jt-row--root={root}>
	{#if canToggle}
		<button
			type="button"
			class="jt-key jt-key--toggle"
			aria-expanded={expanded}
			onclick={toggle}
		>
			<span class="jt-caret" class:jt-caret--open={expanded} aria-hidden="true">▸</span>
			{#if name !== undefined}
				<span class="jt-name">{name}</span><span class="jt-colon">:</span>
			{/if}
			{#if k === 'object'}
				<span class="jt-summary">{'{'}{containerSize} {containerSize === 1 ? 'key' : 'keys'}{'}'}</span>
			{:else}
				<span class="jt-summary">[{containerSize}]</span>
			{/if}
		</button>
	{:else}
		<div class="jt-key">
			<span class="jt-caret jt-caret--placeholder" aria-hidden="true"></span>
			{#if name !== undefined}
				<span class="jt-name">{name}</span><span class="jt-colon">:</span>
			{/if}
			{#if k === 'object' || k === 'array'}
				<span class="jt-summary">{k === 'array' ? '[]' : '{}'}</span>
			{:else if k === 'string'}
				<span class="jt-string">"{displayedString}"</span>
				{#if isLongString}
					<button
						type="button"
						class="jt-expand"
						onclick={() => (strExpanded = !strExpanded)}
					>{strExpanded ? 'collapse' : 'expand'}</button>
				{/if}
			{:else if k === 'number'}
				<span class="jt-number">{value as number}</span>
			{:else if k === 'boolean'}
				<span class="jt-bool">{String(value)}</span>
			{:else if k === 'null'}
				<span class="jt-null">null</span>
			{:else if k === 'undefined'}
				<span class="jt-null">undefined</span>
			{/if}
		</div>
	{/if}

	{#if canToggle && expanded}
		<div class="jt-children">
			{#each entries as [childKey, childVal] (childKey)}
				<Self value={childVal} name={childKey} depth={depth + 1} root={false} />
			{/each}
		</div>
	{/if}
</div>
