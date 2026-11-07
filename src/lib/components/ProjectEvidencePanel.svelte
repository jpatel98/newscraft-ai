<script lang="ts">
 import { onDestroy } from 'svelte';
 import { invalidate } from '$app/navigation';
 import { deleteProjectEvidence, evidenceKindForFile, uploadProjectEvidence, EvidenceClientError, type EvidenceDocumentSummary } from '$lib/client/evidence';
 import { formatRelativeTime } from '$lib/utils/time';

 let { projectId, enabled, documents, inspect = $bindable(null) }: {
  projectId: string;
  enabled: boolean;
  documents: EvidenceDocumentSummary[];
  inspect: { documentId: string; page?: number; ordinals?: number[] } | null;
 } = $props();

 let active = true; onDestroy(() => { active = false; });
 let uploads = $state<Array<{ key: string; name: string; state: 'uploading' | 'processing' | 'failed'; error?: string }>>([]);
 let failure = $state('');
 let removing = $state<string | null>(null);
 let input = $state<HTMLInputElement | null>(null);
 let inspector = $state<{ title: string; kind: 'pdf' | 'csv'; loading: boolean; error: string;
  page?: { pageNumber: number; pageCount: number; text: string };
  rows?: { columns: Array<{ id: string; name: string; inferredType: string }>; rowCount: number; offset: number; rows: Array<{ ordinal: number; sourceLine: number; cells: string[] }> };
 } | null>(null);

 const ready = $derived(documents.filter((document) => document.state === 'ready'));
 const totalBytes = $derived(documents.reduce((sum, document) => sum + document.sizeBytes, 0));

 async function onFiles(event: Event) {
  const target = event.currentTarget as HTMLInputElement;
  const files = Array.from(target.files ?? []);
  target.value = '';
  failure = '';
  for (const file of files) {
   if (!evidenceKindForFile(file)) { failure = `${file.name}: only PDF and CSV files are supported.`; continue; }
   const key = `${file.name}:${file.size}:${Date.now()}:${Math.random()}`;
   uploads = [...uploads, { key, name: file.name, state: 'uploading' }];
   try {
    await uploadProjectEvidence(projectId, file, {
     onProcessing: () => { uploads = uploads.map((upload) => upload.key === key ? { ...upload, state: 'processing' } : upload); }
    });
    if (!active) return;
    uploads = uploads.filter((upload) => upload.key !== key);
    await invalidate('app:evidence');
   } catch (cause) {
    if (!active) return;
    const message = cause instanceof EvidenceClientError ? cause.message : "Couldn't add that file.";
    uploads = uploads.map((upload) => upload.key === key ? { ...upload, state: 'failed', error: message } : upload);
    await invalidate('app:evidence');
   }
  }
 }

 async function remove(document: EvidenceDocumentSummary) {
  if (!confirm(`Remove ${document.name} from this folder? Leads that cite it will be marked “source withdrawn”.`)) return;
  removing = document.id; failure = '';
  try {
   await deleteProjectEvidence(projectId, document.id);
   if (!active) return;
   if (inspector && inspect?.documentId === document.id) { inspector = null; inspect = null; }
   await invalidate('app:evidence');
  } catch (cause) {
   if (!active) return;
   failure = cause instanceof EvidenceClientError ? cause.message : "Couldn't remove that file.";
  } finally { if (active) removing = null; }
 }

 async function loadInspector(target: { documentId: string; page?: number; ordinals?: number[] }, offset = 0) {
  const document = documents.find((item) => item.id === target.documentId);
  if (!document || document.state !== 'ready') return;
  inspector = { title: document.name, kind: document.kind, loading: true, error: '' };
  try {
   if (document.kind === 'pdf') {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(document.id)}?page=${target.page ?? 1}`, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error();
    const body = await response.json() as { page: { pageNumber: number; pageCount: number; text: string } };
    if (!active) return;
    inspector = { title: document.name, kind: 'pdf', loading: false, error: '', page: body.page };
   } else {
    const query = target.ordinals?.length ? `rows=1&ordinals=${target.ordinals.join(',')}` : `rows=1&offset=${offset}&limit=25`;
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(document.id)}?${query}`, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error();
    const body = await response.json() as { rows: { columns: Array<{ id: string; name: string; inferredType: string }>; rowCount: number; rows: Array<{ ordinal: number; sourceLine: number; cells: string[] }> } };
    if (!active) return;
    inspector = { title: document.name, kind: 'csv', loading: false, error: '', rows: { ...body.rows, offset } };
   }
  } catch {
   if (!active) return;
   inspector = { title: document.name, kind: document.kind, loading: false, error: "Couldn't load that part of the file." };
  }
 }

 $effect(() => {
  if (inspect) void loadInspector(inspect);
 });

 function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
 }
 const stateLabel: Record<string, string> = { uploading: 'Uploading', processing: 'Checking and extracting', ready: 'Ready', failed: 'Failed' };
</script>

<section class="evidence" aria-labelledby="evidence-heading">
 <h2 id="evidence-heading">Evidence</h2>
 <p class="project-scope">Files added here are stored privately in NewsCraft’s cloud and processed by NewsCraft. Analysis below runs without any AI provider. When you ask a question in a chat inside this folder, selected excerpts of this evidence are sent to the configured AI model with your question. Nothing is published or shared without your action.</p>
 {#if !enabled}
  <p class="project-empty">Evidence is not enabled on this deployment yet.</p>
 {:else}
  <div class="evidence-toolbar">
   <input bind:this={input} type="file" accept=".pdf,.csv,application/pdf,text/csv" multiple hidden onchange={onFiles} />
   <button type="button" onclick={() => input?.click()}>Add PDF or CSV</button>
   <span class="evidence-meta">{documents.length} file{documents.length === 1 ? '' : 's'} · {formatBytes(totalBytes)} · {ready.length} ready</span>
  </div>
  {#if failure}<p role="alert">{failure}</p>{/if}
  {#if uploads.length}
   <ul class="evidence-list" aria-label="Uploads in progress">
    {#each uploads as upload (upload.key)}
     <li class="evidence-row"><strong>{upload.name}</strong>
      <span class="evidence-state evidence-state-{upload.state}">{upload.state === 'failed' ? upload.error : stateLabel[upload.state]}</span>
      {#if upload.state === 'failed'}<button type="button" class="evidence-link" onclick={() => uploads = uploads.filter((item) => item.key !== upload.key)}>Dismiss</button>{/if}
     </li>
    {/each}
   </ul>
  {/if}
  {#if documents.length}
   <ul class="evidence-list">
    {#each documents as document (document.id)}
     <li class="evidence-row">
      <div class="evidence-name"><strong>{document.name}</strong>
       <span class="evidence-meta">{document.kind.toUpperCase()} · {formatBytes(document.sizeBytes)}
        {#if document.state === 'ready' && document.kind === 'pdf'} · {document.pageCount} page{document.pageCount === 1 ? '' : 's'}{/if}
        {#if document.state === 'ready' && document.kind === 'csv'} · {document.rowCount?.toLocaleString('en-US')} rows × {document.columnCount} columns{/if}
        · added {formatRelativeTime(document.createdAt)}</span>
       {#if document.sha256}<span class="evidence-hash" title="SHA-256 of the sealed bytes">sha256 {document.sha256.slice(0, 12)}…</span>{/if}
      </div>
      <span class="evidence-state evidence-state-{document.state}">{document.state === 'failed' ? (document.error || 'Failed') : stateLabel[document.state]}</span>
      <div class="evidence-actions">
       {#if document.state === 'ready'}
        <button type="button" class="evidence-link" onclick={() => inspect = { documentId: document.id, page: 1 }}>Inspect</button>
        <a class="evidence-link" href={`/api/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(document.id)}/download`} target="_blank" rel="noopener noreferrer">Download original</a>
       {/if}
       <button type="button" class="evidence-link evidence-danger" disabled={removing === document.id} onclick={() => remove(document)}>{removing === document.id ? 'Removing…' : 'Remove'}</button>
      </div>
     </li>
    {/each}
   </ul>
  {:else if !uploads.length}
   <p class="project-empty">No evidence yet. Add procurement spreadsheets, filings or reports as CSV or PDF. Scanned PDFs without a text layer are not supported yet.</p>
  {/if}
  {#if inspector}
   <div class="evidence-inspector" role="region" aria-label="Source inspector">
    <div class="evidence-inspector-head"><strong>{inspector.title}</strong>
     {#if inspector.page}<span class="evidence-meta">page {inspector.page.pageNumber} of {inspector.page.pageCount}</span>{/if}
     {#if inspector.rows}<span class="evidence-meta">{inspector.rows.rowCount.toLocaleString('en-US')} rows</span>{/if}
     <button type="button" class="evidence-link" onclick={() => { inspector = null; inspect = null; }}>Close</button>
    </div>
    {#if inspector.loading}<p>Loading…</p>
    {:else if inspector.error}<p role="alert">{inspector.error}</p>
    {:else if inspector.page}
     <div class="evidence-pager">
      <button type="button" disabled={inspector.page.pageNumber <= 1} onclick={() => inspect = { documentId: inspect!.documentId, page: inspector!.page!.pageNumber - 1 }}>Previous page</button>
      <button type="button" disabled={inspector.page.pageNumber >= inspector.page.pageCount} onclick={() => inspect = { documentId: inspect!.documentId, page: inspector!.page!.pageNumber + 1 }}>Next page</button>
     </div>
     <pre class="evidence-page">{inspector.page.text || '(no extractable text on this page)'}</pre>
    {:else if inspector.rows}
     <div class="evidence-table-wrap"><table class="evidence-table">
      <thead><tr><th scope="col">Row</th>{#each inspector.rows.columns as column (column.id)}<th scope="col">{column.name}<span class="evidence-meta"> {column.inferredType}</span></th>{/each}</tr></thead>
      <tbody>{#each inspector.rows.rows as row (row.ordinal)}<tr><th scope="row">{row.ordinal}</th>{#each row.cells as cell, index (index)}<td>{cell}</td>{/each}</tr>{/each}</tbody>
     </table></div>
     {#if !inspect?.ordinals?.length}
      <div class="evidence-pager">
       <button type="button" disabled={inspector.rows.offset <= 0} onclick={() => void loadInspector(inspect!, Math.max(0, inspector!.rows!.offset - 25))}>Previous rows</button>
       <button type="button" disabled={inspector.rows.offset + 25 >= inspector.rows.rowCount} onclick={() => void loadInspector(inspect!, inspector!.rows!.offset + 25)}>Next rows</button>
      </div>
     {:else}
      <button type="button" class="evidence-link" onclick={() => inspect = { documentId: inspect!.documentId }}>Show all rows</button>
     {/if}
    {/if}
   </div>
  {/if}
 {/if}
</section>
