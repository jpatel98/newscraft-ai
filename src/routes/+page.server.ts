// '/' is always the empty / new-chat page. We deliberately do NOT redirect
// to the most recent conversation here, otherwise the sidebar's "+ new"
// link bounces straight back into the previous thread.
export const load = () => ({});
