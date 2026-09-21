import { readFile } from 'node:fs/promises';
import { splitMigrationStatements } from './migration-runner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, ensureMigrated } from './index';
import { createConversation, addMessage, getMessages } from './conversations';
import { createProject, getProject, listProjects, listProjectConversations, moveConversation, renameProject } from './projects';
const url = process.env.NEWSCRAFT_TEST_DATABASE_URL || '';
describe.skipIf(!url)('account-owned topic projects', () => {
 const a = `projects-a-${Date.now()}`, b = `projects-b-${Date.now()}`;
 beforeAll(async () => {
  await ensureMigrated();
  for (const id of [a,b]) await sql`INSERT INTO accounts (id,email,name,role,created_at,updated_at) VALUES (${id},${id+'@example.test'},'Projects test','member',1,1)`;
 });
 afterAll(async () => { await sql`DELETE FROM accounts WHERE id IN (${a},${b})`; await sql.end({timeout:1}); });
 it('creates, renames, moves and ungroups without changing messages or conversation timestamps', async () => {
  const p = await createProject(a,'Mark Carney'); const second = await createProject(a,'Canada');
  const c = await createConversation(a); await addMessage({conversationId:c.id,role:'assistant',content:'Saved answer with [source](https://example.test)',toolCalls:'{"citations":[1]}'});
  const before = await getMessages(c.id);
  const originalConversation = await sql`SELECT * FROM conversations WHERE id = ${c.id}`;
  expect(await renameProject(a,p.id,'Carney reporting')).toMatchObject({name:'Carney reporting'});
  expect(await moveConversation(a,c.id,p.id)).toBe(true);
  expect(await listProjects(a)).toEqual(expect.arrayContaining([expect.objectContaining({id:p.id,conversationCount:1})]));
  expect(await moveConversation(a,c.id,second.id)).toBe(true);
  expect(await listProjectConversations(a,p.id)).toEqual([]);
  expect(await moveConversation(a,c.id,null)).toBe(true);
  expect(await listProjectConversations(a,second.id)).toEqual([]);
  expect(await getMessages(c.id)).toEqual(before);
  expect(await sql`SELECT * FROM conversations WHERE id = ${c.id}`).toEqual(originalConversation);
 });
 it('creates membership atomically and rejects foreign ownership at repository and database levels', async () => {
  const p = await createProject(a,'Private'); const other = await createProject(b,'Other');
  const c = await createConversation(a,undefined,p.id);
  expect(await listProjectConversations(a,p.id)).toEqual([expect.objectContaining({id:c.id})]);
  expect(await getProject(b,p.id)).toBeUndefined();
  expect(await renameProject(b,p.id,'Intruder')).toBeUndefined();
  expect(await listProjectConversations(b,p.id)).toEqual([]);
  expect(await moveConversation(b,c.id,other.id)).toBe(false);
  expect(await moveConversation(b,c.id,null)).toBe(false);
  expect(await moveConversation(a,c.id,other.id)).toBe(false);
  const before = await sql`SELECT count(*) FROM conversations WHERE account_id = ${b}`;
  await expect(createConversation(b,undefined,p.id)).rejects.toThrow('PROJECT_NOT_FOUND');
  expect(await sql`SELECT count(*) FROM conversations WHERE account_id = ${b}`).toEqual(before);
  await expect(sql`UPDATE project_conversations SET project_id = ${other.id} WHERE conversation_id = ${c.id}`).rejects.toThrow();
  expect(await listProjectConversations(a,p.id)).toHaveLength(1);
 });
 it('adds projects to a populated schema without changing existing conversations or messages', async () => {
  const schema = `project_migration_${Date.now()}`;
  await sql.begin(async tx => {
   await tx.unsafe(`CREATE SCHEMA ${schema}`);
   await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
   await tx`CREATE TABLE accounts (id text PRIMARY KEY)`;
   await tx`CREATE TABLE conversations (id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id), title text)`;
   await tx`CREATE TABLE messages (id text PRIMARY KEY, conversation_id text REFERENCES conversations(id), content text)`;
   await tx`INSERT INTO accounts VALUES ('existing')`;
   await tx`INSERT INTO conversations VALUES ('chat', 'existing', 'Keep this')`;
   await tx`INSERT INTO messages VALUES ('answer', 'chat', 'Keep sources and content')`;
   const migration = await readFile(new URL('../../../../drizzle/0017_topic_projects.sql', import.meta.url), 'utf8');
   for (const statement of splitMigrationStatements(migration)) await tx.unsafe(statement);
   expect(await tx`SELECT * FROM conversations`).toEqual([{ id: 'chat', account_id: 'existing', title: 'Keep this' }]);
   expect(await tx`SELECT * FROM messages`).toEqual([{ id: 'answer', conversation_id: 'chat', content: 'Keep sources and content' }]);
   expect(await tx`SELECT * FROM project_conversations`).toEqual([]);
   await tx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  });
 });

});
