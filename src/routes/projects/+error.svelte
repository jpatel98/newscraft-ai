<script lang="ts">
 import { page } from '$app/state';
 import '$lib/styles/projects.css';
</script>
<svelte:head><title>Project unavailable · NewsCraft</title></svelte:head>
<section class="projects-page">
 <h1>{page.status === 404 ? 'Project not found' : 'Could not load projects'}</h1>
 <p>{page.status === 404 ? 'This project is unavailable for your account.' : 'Your conversations are still saved. Try loading this page again.'}</p>
 <button onclick={() => window.location.reload()}>Reload page</button>
 <p><a href="/projects">All projects</a> · <a href="/">Back to chats</a></p>
</section>
