import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ insert:vi.fn(), values:vi.fn(), transaction:vi.fn(), execute:vi.fn() }));
vi.mock('./index', () => ({ db:mocks, ensureDefaultOrganizationForAccount:vi.fn().mockResolvedValue('org') }));
import { createConversation } from './conversations';
describe('conversation creation transaction scope', () => {
 beforeEach(() => { vi.clearAllMocks(); mocks.insert.mockReturnValue(mocks); mocks.values.mockResolvedValue(undefined); mocks.execute.mockResolvedValue([{id:'project'}]); mocks.transaction.mockImplementation(fn => fn(mocks)); });
 it('keeps the direct insertion path for ordinary chats', async () => {
  await createConversation('owner'); expect(mocks.values).toHaveBeenCalledOnce(); expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
 });
 it('creates project chats inside a transaction after the ownership check', async () => {
  await createConversation('owner',undefined,'project'); expect(mocks.transaction).toHaveBeenCalledOnce(); expect(mocks.execute).toHaveBeenCalledTimes(2); expect(mocks.values).toHaveBeenCalledOnce();
 });
});
