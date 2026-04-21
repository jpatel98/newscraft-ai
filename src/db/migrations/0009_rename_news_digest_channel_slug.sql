UPDATE channels
SET
  slug = 'digest',
  name = 'Digest'
WHERE slug = 'news-digest'
  AND NOT EXISTS (
    SELECT 1
    FROM channels AS keep
    WHERE keep.workspace_id = channels.workspace_id
      AND keep.slug = 'digest'
  );
