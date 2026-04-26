CREATE VIRTUAL TABLE messages_fts USING fts5(
	content,
	content='messages',
	content_rowid='rowid',
	tokenize='porter unicode61'
);
--> statement-breakpoint
INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages;
--> statement-breakpoint
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
	INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
	INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
--> statement-breakpoint
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
	INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
	INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
