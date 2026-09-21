<script lang="ts">
 import { onMount, onDestroy } from 'svelte';
 let active = true; onDestroy(() => { active = false; });
 let ready = $state(false); onMount(() => { ready = true; });
 import { goto } from '$app/navigation';
 import '$lib/styles/projects.css';
 let { data } = $props();
 let name = $state(''); let busy = $state(false); let failure = $state('');
 async function create(event: SubmitEvent) {
  event.preventDefault(); if (busy) return; busy = true; failure = '';
  try {
   const response = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
   if (!response.ok) throw new Error();
   const project = await response.json();
   if (!active) return;
   await goto(`/projects/${project.id}`, { invalidateAll: true });
  } catch { if (!active) return; failure = 'Could not create project. Your name is still here; try again.'; }
  finally { if (active) busy = false; }
 }
</script>
<svelte:head><title>Projects · NewsCraft</title></svelte:head>
<main class="projects-page">
 <h1>Projects</h1><p>Keep conversations about a topic together.</p>
 <form onsubmit={create} class="project-form">
  <label for="project-name">New project name</label>
  <div><input id="project-name" bind:value={name} required maxlength="100" placeholder="e.g. Mark Carney" disabled={!ready || busy} /><button disabled={!ready || busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</button></div>
 </form>
 {#if failure}<p role="alert">{failure}</p>{/if}
 {#if data.projects.length}
 <ul class="project-list">{#each data.projects as project (project.id)}
  <li><a href={`/projects/${project.id}`}><strong>{project.name}</strong><span>{project.conversationCount} conversation{project.conversationCount === 1 ? '' : 's'}</span></a></li>
 {/each}</ul>
 {:else}<p class="project-empty">No projects yet. Create one, then add existing chats or start a new conversation.</p>{/if}
</main>
