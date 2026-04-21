DELETE FROM channels
WHERE slug = 'general'
  AND EXISTS (
    SELECT 1
    FROM channels AS keep
    WHERE keep.workspace_id = channels.workspace_id
      AND keep.slug = 'experts'
  );
