const focusableSelector = [
	'a[href]',
	'button:not([disabled])',
	'textarea:not([disabled])',
	'input:not([disabled]):not([type="hidden"])',
	'select:not([disabled])',
	'[tabindex]:not([tabindex="-1"])'
].join(',');

function isVisible(el: HTMLElement): boolean {
	if (el.getAttribute('aria-hidden') === 'true') return false;
	const style = window.getComputedStyle(el);
	if (style.display === 'none' || style.visibility === 'hidden') return false;
	return el.getClientRects().length > 0;
}

export function activeHTMLElement(): HTMLElement | null {
	const active = document.activeElement;
	return active instanceof HTMLElement ? active : null;
}

export function focusableElements(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(isVisible);
}

export function focusDialog(root: HTMLElement | null, preferred?: HTMLElement | null): void {
	if (!root) return;
	const target = preferred && isVisible(preferred) ? preferred : focusableElements(root)[0] ?? root;
	target.focus({ preventScroll: true });
}

export function restoreFocus(target: HTMLElement | null): void {
	if (!target || !document.contains(target)) return;
	if (target.matches(':disabled,[aria-hidden="true"]')) return;
	target.focus({ preventScroll: true });
}

export function trapTabKey(event: KeyboardEvent, root: HTMLElement | null): boolean {
	if (event.key !== 'Tab' || !root) return false;

	const focusable = focusableElements(root);
	if (focusable.length === 0) {
		event.preventDefault();
		event.stopPropagation();
		root.focus({ preventScroll: true });
		return true;
	}

	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	const active = activeHTMLElement();

	if (focusable.length === 1) {
		event.preventDefault();
		event.stopPropagation();
		first.focus({ preventScroll: true });
		return true;
	}

	if (event.shiftKey && (!active || active === first || !root.contains(active))) {
		event.preventDefault();
		event.stopPropagation();
		last.focus({ preventScroll: true });
		return true;
	}

	if (!event.shiftKey && active === last) {
		event.preventDefault();
		event.stopPropagation();
		first.focus({ preventScroll: true });
		return true;
	}

	return false;
}
