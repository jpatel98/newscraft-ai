import { error } from '@sveltejs/kit';
export async function projectBody(request: Request, allowEmpty = false): Promise<Record<string, unknown>> {
 let body: unknown;
 try {
  const text = await request.text();
  if (allowEmpty && text.length === 0) return {};
  body = JSON.parse(text);
 } catch { throw error(400, 'Invalid JSON'); }
 if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, 'Expected an object');
 return body as Record<string, unknown>;
}
export function projectName(value: unknown): string {
 if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw error(400, 'Project name must be 1–100 characters');
 return value.trim();
}
export function projectId(value: unknown): string | null {
 if (value === null) return null;
 if (typeof value !== 'string' || !value.trim() || value.length > 200) throw error(400, 'Invalid project');
 return value;
}
