-- Proposed only; not executed by the reviewer. Target: ygsiifvjzdazfxflmpjq.
-- Run as postgres after operator review. Preserve the existing function body,
-- owner, SECURITY DEFINER and enabled ensure_rls event trigger.
-- See docs/agent-local-handoff.md for the read-only evidence and verification.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable()
  FROM PUBLIC, anon, authenticated;
