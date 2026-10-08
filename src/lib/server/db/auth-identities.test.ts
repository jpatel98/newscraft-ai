import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const database = vi.hoisted(() => ({ transaction: vi.fn(), select: vi.fn(), insert: vi.fn() }));
const organization = vi.hoisted(() => vi.fn());
const password = vi.hoisted(() => ({ hashPassword: vi.fn(async () => 'hashed'), verifyHash: vi.fn() }));
vi.mock('./index', () => ({ db: database, ensureDefaultOrganizationForAccount: organization }));
vi.mock('$lib/server/auth/password', () => password);
import { ensureSupabaseAccount, createLocalAccount } from './accounts';
describe('external identity mapping and local signup', () => {
    beforeEach(() => vi.clearAllMocks());
    it('namespaces identical external subjects by verified issuer and uses independent member IDs', async () => {
        const rows = new Map<string, any>(), identities = new Map<string, string>(), queries: any[] = [];
        database.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => [...rows.values()].slice(-1) }) }) }));
        database.transaction.mockImplementation(operation => operation({
            insert: () => ({ values: async (row: any) => { rows.set(row.id, row); } }),
            execute: async (statement: any) => {
                const query = new PgDialect().sqlToQuery(statement); queries.push(query);
                if (query.sql.includes('SELECT account_id')) return identities.has(JSON.stringify(query.params)) ? [{ account_id: identities.get(JSON.stringify(query.params)) }] : [];
                if (query.sql.includes('INSERT INTO auth_identities')) identities.set(JSON.stringify(query.params.slice(0, 2)), String(query.params[2]));
                return [];
            }
        }));
        const first = await ensureSupabaseAccount({ issuer: 'https://one.example/auth/v1', id: 'same-subject', email: 'one@example.test', name: 'One' });
        const second = await ensureSupabaseAccount({ issuer: 'https://two.example/auth/v1', id: 'same-subject', email: 'two@example.test', name: 'Two' });
        expect(first.id).not.toBe(second.id);
        expect(first.id).not.toBe('same-subject');
        expect(first.role).toBe('member'); expect(second.role).toBe('member');
        expect(queries.filter(q => q.sql.includes('SELECT account_id')).map(q => q.params)).toEqual([
            ['https://one.example/auth/v1', 'same-subject'], ['https://two.example/auth/v1', 'same-subject']]);
        expect(queries.every(q => !q.sql.includes('WHERE email'))).toBe(true);
    });
    it('local signup stores a member hash without first-user or orphan-data promotion', async () => {
        const values = vi.fn(); database.insert.mockReturnValue({ values });
        const row = await createLocalAccount({ email: 'person@example.test', name: 'Person', password: 'fixture' });
        expect(row.role).toBe('member'); expect(row.passwordHash).toBe('hashed');
        expect(values).toHaveBeenCalledWith(expect.objectContaining({ role: 'member' }));
        expect(database.select).not.toHaveBeenCalled();
        expect(organization).toHaveBeenCalledWith(row.id);
    });
});
