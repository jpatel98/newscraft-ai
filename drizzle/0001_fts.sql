CREATE INDEX messages_content_search_idx
	ON messages USING gin (to_tsvector('simple', content));
