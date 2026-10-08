<script lang="ts">
 import ProjectDetailPage from '$lib/components/ProjectDetailPage.svelte';
 let { data } = $props();
</script>
{#key data.project.id}<ProjectDetailPage {data} />{/key}
