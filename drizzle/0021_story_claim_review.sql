-- A producer or reporter can settle a ledger claim by hand (status and the
-- needs-check flag). Who did it and when is kept so later model turns leave
-- that call alone and the pane can show it.
ALTER TABLE story_claims ADD COLUMN IF NOT EXISTS reviewed_by text;
--> statement-breakpoint
ALTER TABLE story_claims ADD COLUMN IF NOT EXISTS reviewed_at bigint;
