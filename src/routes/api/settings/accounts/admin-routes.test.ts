import { describe, expect, it } from 'vitest';
import * as accountsRoute from './+server';
import * as accountRoute from './[id]/+server';
import * as setupLinkRoute from './[id]/setup-link/+server';
const handlers = [accountsRoute.POST, accountRoute.DELETE, setupLinkRoute.POST];
describe('retired local account administration', () => {
    it.each(handlers)('requires admin authorization', async handler => {
        await expect(handler({ locals: { user: { id: 'member', role: 'member' } } } as any)).rejects.toMatchObject({ status: 403 });
        await expect(handler({ locals: { user: null } } as any)).rejects.toMatchObject({ status: 401 });
    });
    it.each(handlers)('does not create bypass accounts or delete only their local profile', async handler => {
        await expect(handler({ locals: { user: { id: 'admin', role: 'admin' } } } as any)).rejects.toMatchObject({ status: 410 });
    });
});
