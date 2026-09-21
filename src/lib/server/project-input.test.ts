import { describe, expect, it } from 'vitest';
import { projectBody, projectId, projectName } from './project-input';
describe('project request validation', () => {
 it('accepts trimmed names and explicit removal', () => {
  expect(projectName('  Mark Carney  ')).toBe('Mark Carney');
  expect(projectId(null)).toBeNull(); expect(projectId('project-a')).toBe('project-a');
 });
 it('rejects empty, oversized, and non-string input', () => {
  for (const value of ['', ' ', 'x'.repeat(101), null, {}, 3]) expect(() => projectName(value)).toThrow();
  for (const value of ['', ' ', undefined, {}, 3]) expect(() => projectId(value)).toThrow();
 });
 it('rejects malformed JSON and non-object bodies', async () => {
  for (const body of ['{', 'null', '[]', '3']) await expect(projectBody(new Request('https://example.test', { method: 'POST', body }))).rejects.toThrow();
 });
});
