<script lang="ts">
 import { onDestroy } from 'svelte';
 import { goto, invalidate } from '$app/navigation';
 import type { EvidenceDocumentSummary } from '$lib/client/evidence';
 import { DISMISSAL_REASONS, FINDING_KIND_LABELS, isLead, leadPrompt, type AnalysisRunView, type ProjectFindingView } from '$lib/components/project-findings';
 import { formatRelativeTime } from '$lib/utils/time';

 let { projectId, projectName, enabled, documents, findings, latestRun, onInspect }: {
  projectId: string;
  projectName: string;
  enabled: boolean;
  documents: EvidenceDocumentSummary[];
  findings: ProjectFindingView[];
  latestRun: AnalysisRunView | null;
  onInspect: (target: { documentId: string; page?: number; ordinals?: number[] }) => void;
 } = $props();

 let active = true; onDestroy(() => { active = false; });
 let running = $state(false);
 let failure = $state('');
 let busyFinding = $state<string | null>(null);
 let dismissing = $state<string | null>(null);
 let dismissReason = $state<string>(DISMISSAL_REASONS[0]);
 let dismissOther = $state('');
 let reviewing = $state<string | null>(null);
 let reviewNote = $state('');
 let showDismissed = $state(false);
 let expanded = $state<Record<string, boolean>>({});

 const readyCount = $derived(documents.filter((document) => document.state === 'ready').length);
 const leads = $derived(findings.filter((finding) => isLead(finding) && finding.status !== 'dismissed'));
 const summaries = $derived(findings.filter((finding) => !isLead(finding) && finding.status !== 'dismissed'));
 const dismissed = $derived(findings.filter((finding) => finding.status === 'dismissed'));
 const documentById = $derived(new Map(documents.map((document) => [document.id, document])));

 async function analyze() {
  if (running) return;
  running = true; failure = '';
  try {
   const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/analysis`, { method: 'POST', headers: { accept: 'application/json' } });
   const body = await response.json().catch(() => ({})) as { message?: string };
   if (!active) return;
   if (!response.ok) throw new Error(body.message || 'Analysis failed.');
   await invalidate('app:evidence');
  } catch (cause) {
   if (!active) return;
   failure = cause instanceof Error ? cause.message : 'Analysis failed.';
  } finally { if (active) running = false; }
 }

 async function patch(finding: ProjectFindingView, body: { status: string; reviewNote?: string; dismissalReason?: string }) {
  busyFinding = finding.id; failure = '';
  try {
   const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/findings/${encodeURIComponent(finding.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body)
   });
   const payload = await response.json().catch(() => ({})) as { message?: string };
   if (!active) return;
   if (!response.ok) throw new Error(payload.message || 'Could not update the lead.');
   dismissing = null; reviewing = null; reviewNote = ''; dismissOther = '';
   await invalidate('app:evidence');
  } catch (cause) {
   if (!active) return;
   failure = cause instanceof Error ? cause.message : 'Could not update the lead.';
  } finally { if (active) busyFinding = null; }
 }

 async function askInChat(finding: ProjectFindingView) {
  failure = '';
  try {
   const response = await fetch('/api/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId }) });
   if (!response.ok) throw new Error();
   const { id } = await response.json() as { id: string };
   if (!active) return;
   await goto(`/c/${id}#p=${encodeURIComponent(leadPrompt(finding))}`);
  } catch { if (active) failure = 'Could not open a chat for this lead.'; }
 }

 function columnName(item: { columnIds?: string[]; columnNames?: string[] }, columnId: string): string {
  const index = item.columnIds?.indexOf(columnId) ?? -1;
  return (index >= 0 && item.columnNames?.[index]) || columnId;
 }
 const statusLabel: Record<string, string> = { proposed: 'Proposed', saved: 'Saved', reviewed: 'Reviewed by you', dismissed: 'Dismissed', stale: 'Source changed' };
</script>

<section class="findings" aria-labelledby="findings-heading">
 <h2 id="findings-heading">Leads</h2>
 <p class="project-scope">Leads are observations computed from the files above, with the rows and pages behind each one. They are not conclusions: what a record says, what the numbers show and what remains a hypothesis are kept apart, and you decide what to verify.</p>
 {#if enabled}
  <div class="evidence-toolbar">
   <button type="button" disabled={running || readyCount === 0} onclick={analyze}>{running ? 'Analyzing…' : findings.length ? 'Analyze again' : 'Analyze evidence'}</button>
   <span class="evidence-meta">
    {#if latestRun}Last run {formatRelativeTime(latestRun.startedAt)} · {latestRun.status === 'succeeded' ? `${latestRun.findingCount} cards` : latestRun.status}{latestRun.errorMessage ? ` · ${latestRun.errorMessage}` : ''}
    {:else if readyCount === 0}Add and process at least one file to analyze.
    {:else}Not analyzed yet. Analysis is deterministic and calls no AI model.{/if}
   </span>
  </div>
  {#if failure}<p role="alert">{failure}</p>{/if}
  {#if leads.length}
   <ul class="finding-list">
    {#each leads as finding (finding.id)}
     <li class="finding-card finding-{finding.status}">
      <div class="finding-head">
       <span class="finding-kind">{FINDING_KIND_LABELS[finding.kind] ?? finding.kind}{#if finding.rank}&nbsp;· lead {finding.rank}{/if}</span>
       <span class="finding-status">{statusLabel[finding.status]}</span>
      </div>
      <h3>{finding.title}</h3>
      <p class="finding-claim"><strong>Observed:</strong> {finding.claim}</p>
      <p class="finding-method"><strong>How it was calculated:</strong> {finding.calculation.method}
       <span class="evidence-meta">{Object.entries(finding.calculation.counts).map(([key, value]) => `${key} ${value.toLocaleString('en-US')}`).join(' · ')}</span></p>
      <p class="finding-limits"><strong>Limits:</strong> {finding.limitations}</p>
      <p class="finding-next"><strong>Next question:</strong> {finding.nextQuestion}</p>
      <button type="button" class="evidence-link" aria-expanded={expanded[finding.id] ? 'true' : 'false'} onclick={() => expanded = { ...expanded, [finding.id]: !expanded[finding.id] }}>{expanded[finding.id] ? 'Hide' : 'Show'} supporting evidence ({finding.evidence.length})</button>
      {#if expanded[finding.id]}
       <ul class="finding-evidence">
        {#each finding.evidence as item, index (index)}
         <li>
          {#if item.withdrawn}
           <span class="evidence-meta">{item.documentName}: source withdrawn</span>
          {:else if item.kind === 'page'}
           <div class="finding-ref"><strong>{item.documentName}</strong>, page {item.pageNumber}
            {#if documentById.get(item.documentId)?.state === 'ready'}<button type="button" class="evidence-link" onclick={() => onInspect({ documentId: item.documentId, page: item.pageNumber })}>Open page</button>{/if}</div>
           {#if item.excerpt}<blockquote class="finding-excerpt">{item.excerpt}</blockquote>{/if}
          {:else}
           <div class="finding-ref"><strong>{item.documentName}</strong>, rows {(item.rows ?? []).map((row) => row.ordinal).join(', ')}{#if item.excerpt} · {item.excerpt}{/if}
            {#if documentById.get(item.documentId)?.state === 'ready'}<button type="button" class="evidence-link" onclick={() => onInspect({ documentId: item.documentId, ordinals: (item.rows ?? []).map((row) => row.ordinal) })}>Open rows</button>{/if}</div>
           {#if item.rows?.length}
            <div class="evidence-table-wrap"><table class="evidence-table">
             <thead><tr><th scope="col">Row</th>{#each item.columnIds ?? [] as columnId (columnId)}<th scope="col">{columnName(item, columnId)}</th>{/each}</tr></thead>
             <tbody>{#each item.rows as row (row.ordinal)}<tr><th scope="row">{row.ordinal}</th>{#each item.columnIds ?? [] as columnId (columnId)}<td>{row.cells[columnId] ?? ''}</td>{/each}</tr>{/each}</tbody>
            </table></div>
           {/if}
          {/if}
         </li>
        {/each}
       </ul>
      {/if}
      {#if finding.reviewNote}<p class="finding-note"><strong>Your note:</strong> {finding.reviewNote}</p>{/if}
      <div class="finding-actions">
       <button type="button" onclick={() => askInChat(finding)}>Ask about this in chat</button>
       {#if finding.status !== 'saved' && finding.status !== 'reviewed'}<button type="button" disabled={busyFinding === finding.id} onclick={() => patch(finding, { status: 'saved' })}>Save</button>{/if}
       {#if finding.status !== 'reviewed'}<button type="button" disabled={busyFinding === finding.id} onclick={() => { reviewing = reviewing === finding.id ? null : finding.id; reviewNote = ''; }}>Mark reviewed</button>{/if}
       <button type="button" disabled={busyFinding === finding.id} onclick={() => { dismissing = dismissing === finding.id ? null : finding.id; }}>Dismiss</button>
      </div>
      {#if reviewing === finding.id}
       <form class="finding-form" onsubmit={(event) => { event.preventDefault(); void patch(finding, { status: 'reviewed', reviewNote }); }}>
        <label for={`review-${finding.id}`}>What did you check, and what did you conclude?</label>
        <textarea id={`review-${finding.id}`} bind:value={reviewNote} maxlength="1000" rows="3"></textarea>
        <div><button disabled={busyFinding === finding.id}>Record review</button><button type="button" onclick={() => reviewing = null}>Cancel</button></div>
       </form>
      {/if}
      {#if dismissing === finding.id}
       <form class="finding-form" onsubmit={(event) => { event.preventDefault(); void patch(finding, { status: 'dismissed', dismissalReason: dismissReason === 'Other' ? dismissOther : dismissReason }); }}>
        <label for={`dismiss-${finding.id}`}>Why dismiss this lead?</label>
        <select id={`dismiss-${finding.id}`} bind:value={dismissReason}>{#each DISMISSAL_REASONS as reason (reason)}<option value={reason}>{reason}</option>{/each}</select>
        {#if dismissReason === 'Other'}<input type="text" bind:value={dismissOther} maxlength="300" placeholder="Reason" required />{/if}
        <div><button disabled={busyFinding === finding.id}>Dismiss lead</button><button type="button" onclick={() => dismissing = null}>Cancel</button></div>
       </form>
      {/if}
     </li>
    {/each}
   </ul>
  {:else if latestRun?.status === 'succeeded'}
   <p class="project-empty">No leads surfaced from the current evidence. Dataset summaries are below.</p>
  {/if}
  {#if summaries.length}
   <h3 class="finding-group">Dataset summaries</h3>
   <ul class="finding-list finding-list-compact">
    {#each summaries as finding (finding.id)}
     <li class="finding-card finding-summary"><h4>{finding.title}</h4><p>{finding.claim}</p><p class="evidence-meta">{finding.limitations}</p></li>
    {/each}
   </ul>
  {/if}
  {#if dismissed.length}
   <button type="button" class="evidence-link" onclick={() => showDismissed = !showDismissed}>{showDismissed ? 'Hide' : 'Show'} {dismissed.length} dismissed</button>
   {#if showDismissed}
    <ul class="finding-list finding-list-compact">
     {#each dismissed as finding (finding.id)}
      <li class="finding-card finding-dismissed"><h4>{finding.title}</h4><p class="evidence-meta">Dismissed: {finding.dismissalReason}</p>
       <button type="button" class="evidence-link" disabled={busyFinding === finding.id} onclick={() => patch(finding, { status: 'proposed' })}>Reopen</button></li>
     {/each}
    </ul>
   {/if}
  {/if}
 {/if}
</section>

