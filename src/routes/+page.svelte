<script lang="ts">
	import Composer from '$lib/components/Composer.svelte';
</script>

<div style="display:flex;flex-direction:column;height:100%;justify-content:center;align-items:center;padding:2rem">
	<h2 style="margin-bottom:1rem;color:#444;font-weight:400">What's on your mind?</h2>
	<div style="width:100%;max-width:720px">
		<Composer />
	</div>
</div>
