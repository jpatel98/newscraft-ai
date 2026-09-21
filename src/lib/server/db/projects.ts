import { sql } from './index';
import { newId } from '$lib/utils/id';

export type Project = { id: string; name: string; createdAt: number; updatedAt: number; conversationCount: number };
export async function listProjects(accountId: string): Promise<Project[]> {
 const rows = await sql`SELECT p.id, p.name, p.created_at AS "createdAt", p.updated_at AS "updatedAt",
 count(pc.conversation_id)::int AS "conversationCount" FROM projects p
 LEFT JOIN project_conversations pc ON pc.project_id = p.id AND pc.account_id = p.account_id
 WHERE p.account_id = ${accountId} GROUP BY p.id ORDER BY p.updated_at DESC, p.id`;
 return rows.map(r => ({ ...r, createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt) })) as Project[];
}
export async function getProject(accountId: string, id: string) {
 const [row] = await sql`SELECT id, name FROM projects WHERE id = ${id} AND account_id = ${accountId}`;
 return row as { id: string; name: string } | undefined;
}
export async function createProject(accountId: string, name: string) {
 const id = newId(); const now = Date.now();
 await sql`INSERT INTO projects (id, account_id, name, created_at, updated_at) VALUES (${id}, ${accountId}, ${name}, ${now}, ${now})`;
 return { id, name };
}
export async function renameProject(accountId: string, id: string, name: string) {
 const [row] = await sql`UPDATE projects SET name = ${name}, updated_at = ${Date.now()} WHERE id = ${id} AND account_id = ${accountId} RETURNING id, name`;
 return row;
}
export async function listProjectConversations(accountId: string, projectId: string) {
 const rows = await sql`SELECT c.id, c.title, c.updated_at AS "updatedAt" FROM conversations c
 JOIN project_conversations pc ON pc.conversation_id = c.id AND pc.account_id = c.account_id
 WHERE pc.project_id = ${projectId} AND pc.account_id = ${accountId} ORDER BY c.updated_at DESC, c.id`;
 return rows.map(r => ({ id: String(r.id), title: String(r.title || '(untitled)'), updatedAt: Number(r.updatedAt) }));
}
export async function getConversationProject(accountId: string, conversationId: string) {
 const [row] = await sql`SELECT p.id, p.name FROM projects p JOIN project_conversations pc ON pc.project_id = p.id AND pc.account_id = p.account_id
 WHERE pc.account_id = ${accountId} AND pc.conversation_id = ${conversationId}`;
 return row as { id: string; name: string } | undefined;
}
export async function moveConversation(accountId: string, conversationId: string, projectId: string | null) {
 return sql.begin(async tx => {
  const [conversation] = await tx`SELECT id FROM conversations WHERE id = ${conversationId} AND account_id = ${accountId} FOR UPDATE`;
  if (!conversation) return false;
  if (projectId === null) {
   await tx`DELETE FROM project_conversations WHERE conversation_id = ${conversationId} AND account_id = ${accountId}`;
  } else {
   const [project] = await tx`SELECT id FROM projects WHERE id = ${projectId} AND account_id = ${accountId} FOR KEY SHARE`;
   if (!project) return false;
   await tx`INSERT INTO project_conversations (conversation_id, account_id, project_id) VALUES (${conversationId}, ${accountId}, ${projectId})
    ON CONFLICT (conversation_id) DO UPDATE SET project_id = EXCLUDED.project_id`;
  }
  return true;
 });
}
