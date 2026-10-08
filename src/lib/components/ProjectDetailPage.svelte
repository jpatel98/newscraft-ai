<script lang="ts">
 import { onMount, onDestroy } from 'svelte';
 let active = true; onDestroy(() => { active = false; });
 let ready = $state(false); onMount(() => { ready = true; });
 import { invalidateAll } from '$app/navigation';
 import Composer from '$lib/components/Composer.svelte';
 import { formatRelativeTime } from '$lib/utils/time';
 import '$lib/styles/projects.css';
 let { data }: { data: { project: { id: string; name: string }; projectConversations: { id: string; title: string; updatedAt: number }[] } } = $props();
 let editing = $state(false); let name = $state(''); let busy = $state(false); let failure = $state('');
 async function rename(event: SubmitEvent) {
  event.preventDefault(); if (busy) return; busy = true; failure = '';
  try {
   const response = await fetch(`/api/projects/${data.project.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
   if (!active) return;
   if (!response.ok) throw new Error();
   await invalidateAll(); if (active) editing = false;
  } catch { if (!active) return; failure = 'Could not rename project. Try again.'; } finally { if (active) busy = false; }
 }
</script>
<svelte:head><title>{data.project.name} · NewsCraft</title></svelte:head>
<main class="projects-page">
 <a href="/projects">All projects</a>
 <header class="project-heading"><h1>{data.project.name}</h1><button disabled={!ready} onclick={() => { name = data.project.name; editing = true; }}>Rename project</button></header>
 {#if editing}<form onsubmit={rename} class="project-form">
  <label for="rename-project">Project name</label><div><input id="rename-project" bind:value={name} required maxlength="100" disabled={!ready || busy} /><button disabled={!ready || busy || !name.trim()}>{busy ? 'Saving…' : 'Save name'}</button><button type="button" disabled={!ready || busy} onclick={() => editing = false}>Cancel</button></div>
 </form>{/if}
 {#if failure}<p role="alert">{failure}</p>{/if}
 <section aria-label="New conversation in project"><h2>New conversation</h2>
 {#key data.project.id}<Composer projectId={data.project.id} draftKey={`project:${data.project.id}`} placeholder={`Ask about ${data.project.name}…`} />{/key}
 </section>
 <h2>Conversations</h2>
 <p>Add existing chats using “Move to project” in a chat’s menu.</p>
 {#if data.projectConversations.length}
 <ul class="project-list">{#each data.projectConversations as conversation (conversation.id)}
 <li><a href={`/c/${conversation.id}`}><strong>{conversation.title}</strong><span>{formatRelativeTime(conversation.updatedAt)}</span></a><a class="project-manage" href={`/c/${conversation.id}/project`}>Move or remove<span class="sr-only"> {conversation.title}</span></a></li>
 {/each}</ul>
 {:else}<p class="project-empty">No conversations in this project yet. Start one above or move an existing chat here.</p>{/if}
</main>
