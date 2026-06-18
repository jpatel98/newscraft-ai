<script lang="ts">
	interface Props {
		content: string;
	}

	type TextItem = {
		label?: string;
		text: string;
	};
	type TextBlock =
		| { type: 'heading'; text: string }
		| { type: 'paragraph'; item: TextItem }
		| { type: 'list'; items: TextItem[] }
		| { type: 'table'; headers: string[]; rows: string[][] }
		| { type: 'pre'; text: string };

	let { content }: Props = $props();

	const blocks = $derived(parseMessageText(content));

	function parseMessageText(raw: string): TextBlock[] {
		const normalized = normalizeDisplayText(raw);
		if (!normalized) return [];

		const blocks: TextBlock[] = [];
		const paragraphLines: string[] = [];
		let currentList: TextItem[] | null = null;
		let lastPushedWasHeading = false;
		const lines = normalized.split('\n');

		function flushParagraph() {
			if (!paragraphLines.length) return;
			const text = paragraphLines.join(' ').replace(/\s+/g, ' ').trim();
			paragraphLines.length = 0;
			if (!text) return;
			blocks.push({ type: 'paragraph', item: itemFromText(text) });
			lastPushedWasHeading = false;
		}

		function flushList() {
			if (!currentList?.length) {
				currentList = null;
				return;
			}
			blocks.push({ type: 'list', items: currentList });
			currentList = null;
			lastPushedWasHeading = false;
		}

		for (let index = 0; index < lines.length; index += 1) {
			const rawLine = lines[index];
			const line = cleanLine(rawLine);
			if (!line) {
				flushParagraph();
				flushList();
				continue;
			}

			const table = tableAt(lines, index);
			if (table) {
				flushParagraph();
				flushList();
				blocks.push(table.block);
				index = table.endIndex;
				lastPushedWasHeading = false;
				continue;
			}

			const heading = headingText(line);
			if (heading) {
				flushParagraph();
				flushList();
				blocks.push({ type: 'heading', text: heading });
				lastPushedWasHeading = true;
				continue;
			}

			const bullet = bulletText(line);
			if (bullet) {
				flushParagraph();
				currentList ??= [];
				currentList.push(itemFromText(bullet));
				lastPushedWasHeading = false;
				continue;
			}

			if ((lastPushedWasHeading || currentList) && hasStoryLabel(line)) {
				flushParagraph();
				currentList ??= [];
				currentList.push(itemFromText(line));
				lastPushedWasHeading = false;
				continue;
			}

			flushList();
			paragraphLines.push(line);
			lastPushedWasHeading = false;
		}

		flushParagraph();
		flushList();
		return blocks;
	}

	function normalizeDisplayText(value: string): string {
		return repairInlineStoryBreaks(stripCitationNoise(value))
			.replace(/\r\n?/g, '\n')
			.replace(/```(?:markdown|md|text|html)?\n?/gi, '')
			.replace(/```/g, '')
			.replace(/[ \t]+\n/g, '\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim();
	}

	function stripCitationNoise(value: string): string {
		return value
			.replace(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:sources?|references?|citations?)\b\s*:?\s*[\s\S]*$/i, '')
			.replace(/\s+\bSOURCES\b\s+[\s\S]*$/i, '')
			.replace(/\bPosted times?:\s*[\s\S]*?(?=\s+(?:Additional confirmations?|AP write[- ]?up|Canadian Press version|Sources?:)\b|$)/gi, '')
			.replace(/\bAdditional confirmations?:\s*[\s\S]*$/i, '')
			.replace(/\bAP write[- ]?up carried by\s*[\s\S]*$/i, '')
			.replace(/\bCanadian Press version carried by\s*[\s\S]*$/i, '')
			.replace(/\bIt is based on media\/search results and should be checked against a primary source before publication\.?/gi, '')
			.replace(/\bshould be checked against a primary source before publication\.?/gi, '')
			.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, '$1')
			.replace(/https?:\/\/\S+/gi, '')
			.replace(/\s+\((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^)]*)?\)/gi, '');
	}

	function repairInlineStoryBreaks(value: string): string {
		return value
			.replace(/\s*,?\s*ordered by freshness:?\s*/gi, ':\n')
			.replace(/:\s+-\s+/g, ':\n- ')
			.replace(
				/\s+-\s+(?=(?:Today|Yesterday|Latest|This morning|This afternoon|This evening|[A-Z][A-Za-z0-9'’$,.&/ ]{2,80})\s+[-–—]\s+)/g,
				'\n- '
			);
	}

	function cleanLine(value: string): string {
		return value
			.trim()
			.replace(/^#{1,6}\s+/, '')
			.replace(/^>\s*/, '')
			.replace(/\*\*([^*]+)\*\*/g, '$1')
			.replace(/__([^_]+)__/g, '$1')
			.replace(/`([^`]+)`/g, '$1')
			.replace(/\s+/g, ' ')
			.trim();
	}

	function headingText(line: string): string {
		const cleaned = cleanLine(line).replace(/:$/, '').trim();
		if (!cleaned || cleaned.length > 54) return '';
		if (/[.!?]$/.test(cleaned)) return '';
		if (
			/^(today|yesterday|latest context|what changed|why it matters|next watch|key updates|quick answer|context|what we know|what to watch|latest|recent updates)$/i.test(
				cleaned
			)
		) {
			return titleCaseKnownHeading(cleaned);
		}
		return '';
	}

	function titleCaseKnownHeading(value: string): string {
		const lower = value.toLowerCase();
		const known: Record<string, string> = {
			today: 'Today',
			yesterday: 'Yesterday',
			'latest context': 'Latest Context',
			'what changed': 'What Changed',
			'why it matters': 'Why It Matters',
			'next watch': 'Next Watch',
			'key updates': 'Key Updates',
			'quick answer': 'Quick Answer',
			context: 'Context',
			'what we know': 'What We Know',
			'what to watch': 'What To Watch',
			latest: 'Latest',
			'recent updates': 'Recent Updates'
		};
		return known[lower] || value;
	}

	function bulletText(line: string): string {
		const match = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
		if (!match) return '';
		return normalizeStoryItemText(match[1]);
	}

	function normalizeStoryItemText(value: string): string {
		return value
			.replace(/^Bold:\s*([^-–—:\n]{2,100})\s+[-–—]\s+/, '$1: ')
			.replace(/^(Today|Yesterday|Latest|This morning|This afternoon|This evening)\s+[-–—]\s+/i, '$1: ')
			.replace(/^([A-Z][^:\n]{2,80})\s+[-–—]\s+/, '$1: ')
			.trim();
	}

	function hasStoryLabel(line: string): boolean {
		const item = itemFromText(line);
		return Boolean(item.label && item.text);
	}

	function itemFromText(value: string): TextItem {
		const normalized = normalizeStoryItemText(value);
		const labelMatch = normalized.match(/^([^:\n]{2,95}):\s+(.+)$/);
		if (!labelMatch) return { text: normalized };
		const label = labelMatch[1].trim();
		const text = labelMatch[2].trim();
		if (!text || looksLikeUrl(label)) return { text: normalized };
		return { label: label.replace(/^Bold$/i, '').trim() || undefined, text };
	}

	function looksLikeUrl(value: string): boolean {
		return /^https?:\/\//i.test(value) || /^[a-z0-9.-]+\.[a-z]{2,}/i.test(value);
	}

	function tableAt(lines: string[], index: number): { block: TextBlock; endIndex: number } | null {
		const first = cleanLine(lines[index]);
		const second = cleanLine(lines[index + 1] || '');
		if (!isPipeRow(first) || !isPipeSeparator(second)) return null;

		const headers = pipeCells(first);
		const rows: string[][] = [];
		let endIndex = index + 1;
		for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
			const row = cleanLine(lines[rowIndex]);
			if (!isPipeRow(row)) break;
			rows.push(pipeCells(row));
			endIndex = rowIndex;
		}
		return rows.length ? { block: { type: 'table', headers, rows }, endIndex } : null;
	}

	function isPipeRow(value: string): boolean {
		return value.includes('|') && value.split('|').filter((cell) => cell.trim()).length >= 2;
	}

	function isPipeSeparator(value: string): boolean {
		return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(value);
	}

	function pipeCells(value: string): string[] {
		return value
			.replace(/^\|/, '')
			.replace(/\|$/, '')
			.split('|')
			.map((cell) => cleanLine(cell));
	}
</script>

<div class="msg-text">
	{#each blocks as block}
		{#if block.type === 'heading'}
			<h3>{block.text}</h3>
		{:else if block.type === 'paragraph'}
			<p>
				{#if block.item.label}
					<strong>{block.item.label}:</strong><span class="msg-text__item-text">{block.item.text}</span>
				{:else}
					{block.item.text}
				{/if}
			</p>
		{:else if block.type === 'list'}
			<ul>
				{#each block.items as item}
					<li>
						{#if item.label}
							<strong>{item.label}:</strong><span class="msg-text__item-text">{item.text}</span>
						{:else}
							{item.text}
						{/if}
					</li>
				{/each}
			</ul>
		{:else if block.type === 'table'}
			<div class="msg-text__table-wrap">
				<table>
					<thead>
						<tr>
							{#each block.headers as header}
								<th>{header}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each block.rows as row}
							<tr>
								{#each block.headers as _header, index}
									<td>{row[index] || ''}</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else if block.type === 'pre'}
			<pre>{block.text}</pre>
		{/if}
	{/each}
</div>
