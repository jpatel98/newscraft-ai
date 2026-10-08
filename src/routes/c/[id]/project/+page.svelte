<script lang="ts">
 import ConversationProjectPage from '$lib/components/ConversationProjectPage.svelte';
 let { data } = $props();
</script>
{#key data.conversation.id}<ConversationProjectPage {data} />{/key}
