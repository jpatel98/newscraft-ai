<script lang="ts">
	import ChevronDown from 'lucide-svelte/icons/chevron-down';
	import FileText from 'lucide-svelte/icons/file-text';
	import {
		ANSWER_USE_ACTIONS,
		type AnswerUseAction
	} from './journalist-ui';

	interface Props {
		messageId: string;
		disabled?: boolean;
		onSelect: (action: AnswerUseAction) => Promise<void> | void;
	}

	let { messageId, disabled = false, onSelect }: Props = $props();
	let open = $state(false);
	let dispatching = $state(false);
	let actionError = $state<string | null>(null);
	let wrapper: HTMLDivElement | undefined = $state();
	let trigger: HTMLButtonElement | undefined = $state();
	let menu: HTMLDivElement | undefined = $state();

	const menuId = $derived(`answer-actions-${messageId.replace(/[^A-Za-z0-9_-]/g, '-')}`);

	function menuButtons(): HTMLButtonElement[] {
		return menu ? Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) : [];
	}

	function openMenu(focusFirst = false) {
		if (disabled || dispatching) return;
		actionError = null;
		open = true;
		if (focusFirst) queueMicrotask(() => menuButtons()[0]?.focus());
	}

	function closeMenu(restoreFocus = false) {
		open = false;
		if (restoreFocus) queueMicrotask(() => trigger?.focus());
	}

	function onWindowClick(event: MouseEvent) {
		if (!open || wrapper?.contains(event.target as Node)) return;
		closeMenu();
	}

	function onTriggerKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			openMenu(true);
		} else if (event.key === 'Escape' && open) {
			event.preventDefault();
			closeMenu(true);
		}
	}

	function onMenuKeydown(event: KeyboardEvent) {
		const buttons = menuButtons();
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
		if (event.key === 'Escape') {
			event.preventDefault();
			closeMenu(true);
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			buttons[(index + 1 + buttons.length) % buttons.length]?.focus();
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
		} else if (event.key === 'Home') {
			event.preventDefault();
			buttons[0]?.focus();
		} else if (event.key === 'End') {
			event.preventDefault();
			buttons.at(-1)?.focus();
		}
	}

	function select(action: AnswerUseAction) {
		closeMenu(true);
		dispatching = true;
		actionError = null;
		void Promise.resolve(onSelect(action))
			.catch(() => {
				actionError = "Couldn't start that format. Your answer is unchanged.";
			})
			.finally(() => {
				dispatching = false;
			});
	}
</script>

<svelte:window onclick={onWindowClick} />

<div class="answer-actions" bind:this={wrapper}>
	<button
		bind:this={trigger}
		type="button"
		class="answer-actions__trigger"
		disabled={disabled || dispatching}
		aria-haspopup="menu"
		aria-controls={menuId}
		aria-expanded={open}
		onclick={() => (open ? closeMenu() : openMenu())}
		onkeydown={onTriggerKeydown}
	>
		<FileText size="11" strokeWidth={1.6} aria-hidden="true" />
		<span>{dispatching ? 'Starting' : 'Use answer'}</span>
		<ChevronDown size="11" strokeWidth={1.7} aria-hidden="true" />
	</button>

	{#if open}
		<div
			bind:this={menu}
			id={menuId}
			class="answer-actions__menu"
			role="menu"
			tabindex="-1"
			aria-label="Use answer as"
			onkeydown={onMenuKeydown}
		>
			{#each ANSWER_USE_ACTIONS as action (action.action)}
				<button
					type="button"
					class="answer-actions__item"
					role="menuitem"
					onclick={() => select(action.action)}
				>
					{action.label}
				</button>
			{/each}
		</div>
	{/if}

	{#if actionError}
		<span class="answer-actions__error" role="status">{actionError}</span>
	{/if}
</div>

<style>
	.answer-actions {
		position: relative;
		display: inline-flex;
		align-items: center;
	}

	.answer-actions__trigger {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-height: 26px;
		padding: 2px 7px;
		border: 1px solid transparent;
		border-radius: var(--radius-1);
		background: transparent;
		color: var(--fg-3);
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 500;
		letter-spacing: 0;
		cursor: pointer;
	}

	.answer-actions__trigger:hover,
	.answer-actions__trigger[aria-expanded='true'] {
		border-color: var(--border-soft);
		background: var(--bg-raised);
		color: var(--fg-1);
	}

	.answer-actions__trigger:focus-visible,
	.answer-actions__item:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus);
	}

	.answer-actions__trigger:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.answer-actions__menu {
		position: absolute;
		left: 0;
		bottom: calc(100% + 5px);
		z-index: 25;
		width: 190px;
		padding: 4px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-2);
		background: var(--bg-surface);
		box-shadow: var(--shadow-2);
	}

	.answer-actions__item {
		display: block;
		width: 100%;
		min-height: 32px;
		padding: 6px 8px;
		border: 0;
		border-radius: var(--radius-1);
		background: transparent;
		color: var(--fg-1);
		font-size: 12px;
		line-height: 1.3;
		letter-spacing: 0;
		text-align: left;
		cursor: pointer;
	}

	.answer-actions__item:hover,
	.answer-actions__item:focus-visible {
		background: var(--bg-raised);
	}

	.answer-actions__error {
		position: absolute;
		left: 0;
		top: calc(100% + 5px);
		width: max-content;
		max-width: min(300px, 70vw);
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--danger-fg, #b34040);
	}

	@media (max-width: 760px) {
		.answer-actions__trigger {
			min-height: 44px;
			padding-inline: 8px;
		}
	}
</style>
