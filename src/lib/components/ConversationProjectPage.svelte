<script lang="ts">
 import { onMount, onDestroy } from 'svelte';
 let active = true; onDestroy(() => { active = false; });
 let ready = $state(false); onMount(() => { ready = true; });
 import { goto } from '$app/navigation';
 import '$lib/styles/projects.css';
 let { data }: { data: { conversation: { id: string; title: string }; membership: { id: string; name: string } | null; projects: { id: string; name: string }[] } } = $props();
 let selection = $state<string | undefined>(undefined); let busy = $state(false); let failure = $state('');
 const selected = $derived(selection ?? data.membership?.id ?? '');
 async function save(event: SubmitEvent) {
  event.preventDefault(); if (busy) return; busy = true; failure = '';
  try {
   const response = await fetch(`/api/conversations/${data.conversation.id}/project`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: selected || null }) });
   if (!active) return;
   if (!response.ok) throw new Error();
   await goto(selected ? `/projects/${selected}` : `/c/${data.conversation.id}`, { invalidateAll: true });
  } catch { if (!active) return; failure = 'Could not move this conversation. Try again.'; } finally { if (active) busy = false; }
 }
</script>
<svelte:head><title>Move conversation · NewsCraft</title></svelte:head>
<main class="projects-page">
 <a href={`/c/${data.conversation.id}`}>Back to conversation</a>
 <h1>Move to project</h1><p>{data.conversation.title || '(untitled)'}</p>
 <p>Current project: {data.membership?.name ?? 'No project'}</p>
 <form onsubmit={save} class="project-form">
 <label for="destination">Project</label><div><select id="destination" value={selected} onchange={event => selection = event.currentTarget.value} disabled={!ready || busy}>
 <option value="">No project (ungrouped)</option>{#each data.projects as project (project.id)}<option value={project.id}>{project.name}</option>{/each}
 </select><button disabled={!ready || busy}>{busy ? 'Moving…' : 'Save project'}</button></div>
 </form>
 {#if failure}<p role="alert">{failure}</p>{/if}
 {#if !data.projects.length}<p><a href="/projects">Create your first project</a> to group this conversation.</p>{/if}
</main>
