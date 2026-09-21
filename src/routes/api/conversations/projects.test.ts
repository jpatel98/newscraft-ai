import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ createConversation: vi.fn() }));
vi.mock('$lib/server/db/conversations', () => mocks);
import { POST } from './+server';
describe('conversation creation API compatibility', () => {
 beforeEach(() => { vi.clearAllMocks(); mocks.createConversation.mockResolvedValue({id:'chat'}); });
 function request(body?: string) { return {request:new Request('https://example.test/api/conversations',{method:'POST', ...(body === undefined ? {} : {body})}),locals:{user:{id:'owner'}}} as any; }
 it('preserves both omitted and explicitly empty request bodies', async () => {
  for (const body of [undefined,'']) {
   const response = await POST(request(body)); expect(response.status).toBe(200);
   expect(mocks.createConversation).toHaveBeenLastCalledWith('owner',undefined,null);
  }
 });
 it('rejects malformed nonempty JSON and invalid membership without creating a chat', async () => {
  for (const body of ['{','null','[]','{"projectId":4}','{"projectId":""}']) await expect(POST(request(body))).rejects.toMatchObject({status:400});
  expect(mocks.createConversation).not.toHaveBeenCalled();
 });
 it('passes project membership and keeps missing/foreign projects private', async () => {
  await POST(request('{"projectId":"project"}'));
  expect(mocks.createConversation).toHaveBeenCalledWith('owner',undefined,'project');
  mocks.createConversation.mockRejectedValue(new Error('PROJECT_NOT_FOUND'));
  await expect(POST(request('{"projectId":"foreign"}'))).rejects.toMatchObject({status:404});
 });
});
