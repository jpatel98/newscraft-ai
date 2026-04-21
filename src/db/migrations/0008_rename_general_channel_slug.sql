UPDATE channels
SET
  slug = 'experts',
  name = 'Experts'
WHERE slug = 'general'
  AND NOT EXISTS (
    SELECT 1
    FROM channels AS keep
    WHERE keep.workspace_id = channels.workspace_id
      AND keep.slug = 'experts'
  );
