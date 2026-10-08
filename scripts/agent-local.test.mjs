import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'dotenv';
import { localDefaults, parseLocalArguments, prepareLocal, resolveLocalSetup, checkLocal, runLocal } from './agent-local.mjs';

const KEY = 'sk-public-synthetic-fixture-not-a-real-key';
const TOKEN = 'public-synthetic-listener-token-123456';
const CALLBACK = 'public-synthetic-callback-token-123456';
const TENANT = 'public-synthetic-tenant-secret-123456';
const SESSION = Buffer.alloc(32, 'fixture').toString('base64');
const OLD_DB = 'postgresql://old_user:old_fixture_password@old.example.test/old_db';
const TEST_DB = 'postgresql://test_user:test_fixture_password@test.example.test/test_db';
const PROJECT_REF = 'ygsiifvjzdazfxflmpjq';
const NEW_DB = `postgresql://postgres:public_synthetic_password@db.${PROJECT_REF}.supabase.co:5432/postgres?sslmode=verify-full`;
// Synthetic hostname only; never inferred or used as the project's real pooler URL.
const SESSION_DB = `postgresql://postgres.${PROJECT_REF}:public_synthetic_password@synthetic-fixture.pooler.supabase.com:5432/postgres?sslmode=verify-full`;
const STORAGE_KEY = 'public-synthetic-storage-key-123456';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'newscraft-local-setup-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const put = (path, value, mode = 0o600) => {
        const target = join(root, path); mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, value, { mode });
    };
    put('.env.local', `DATABASE_URL=${OLD_DB}\nNEWSCRAFT_TEST_DATABASE_URL=${TEST_DB}\nNEWSCRAFT_HERMES_API_TOKEN=${TOKEN}\nNEWSCRAFT_HERMES_RUN_API_TOKEN=${CALLBACK}\nNEWSCRAFT_HERMES_TENANT_SECRET=${TENANT}\nAPP_SESSION_SECRET=${SESSION}\nNEWSCRAFT_STORAGE_BASE_URL=https://storage.example.test\nNEWSCRAFT_STORAGE_API_KEY=${STORAGE_KEY}\nOPENAI_API_KEY=sk-unapproved-root-value-which-must-not-propagate\n`);
    put('services/hermes-chat/.env', `HERMES_AGUI_SESSION_TOKEN=${TOKEN}\nNEWSCRAFT_AGENT_RUN_API_TOKEN=${CALLBACK}\n`);
    put('services/newsroom-harness/.env.local', `OPENAI_API_KEY=${KEY}\nUNRELATED_SECRET=never-load-me\n`);
    put('services/hermes-chat/.venv-owned/bin/python', '# synthetic interpreter fixture, never executed\n', 0o700);
    put('services/hermes-chat/.venv-owned/pyvenv.cfg', 'include-system-site-packages = false\n');
    for (const name of ['fastapi', 'httpx', 'ddgs', 'uvicorn']) put(`services/hermes-chat/.venv-owned/lib/python3.11/site-packages/${name}/__init__.py`, '');
    put('services/hermes-chat/.venv-owned/lib/python3.11/site-packages/newscraft_agent-0.1.0.dist-info/METADATA', 'synthetic');
    put('node_modules/.bin/vite', 'synthetic');
    prepareLocal({ root });
    return { root, put, env: { NEWSCRAFT_SETUP_DATABASE_URL: NEW_DB } };
}

function existingFiles(root) {
    return ['.env.local', 'services/hermes-chat/.env', 'services/newsroom-harness/.env.local'].map(path => readFileSync(join(root, path), 'utf8'));
}

test('prepare writes only nonsecret defaults and never replaces an existing profile', t => {
    const { root } = fixture(t);
    const before = existingFiles(root);
    const profile = readFileSync(join(root, '.env.agent-local'), 'utf8');
    const parsed = parse(profile);
    assert.equal(parsed.DATABASE_URL, '');
    assert.equal(parsed.NEWSCRAFT_SETUP_PROJECT_REF, PROJECT_REF);
    assert.equal(parsed.NEWSCRAFT_STORAGE_PROVIDER, 'vps');
    assert.equal(parsed.NEWSCRAFT_AGENT_MAX_COST_USD, '4.23');
    assert.equal(parsed.NEWSCRAFT_AGENT_INPUT_PRICE_CEILING, '25');
    assert.equal(parsed.NEWSCRAFT_AGENT_OUTPUT_PRICE_CEILING, '75');
    assert.equal(parsed.OPENAI_BASE_URL, 'https://api.openai.com/v1');
    assert.equal(parsed.NEWSCRAFT_AGENT_MAX_ACTIVE_RUNS, '1');
    assert.equal(parsed.NEWSCRAFT_AGENT_MAX_QUEUED_RUNS, '1');
    assert.match(parsed.NEWSCRAFT_AGENT_BIN, /\.venv-owned\/bin\/python$/);
    assert.match(parsed.NEWSCRAFT_AGENT_STATE_HOME, /\.data\/agent-local\/state$/);
    for (const value of [KEY, TOKEN, CALLBACK, TENANT, SESSION, STORAGE_KEY, OLD_DB]) assert.ok(!profile.includes(value));
    assert.match(prepareLocal({ root }).message, /preserved/);
    assert.equal(readFileSync(join(root, '.env.agent-local'), 'utf8'), profile);
    assert.deepEqual(existingFiles(root), before);
});

test('blank profile never falls back to old root, service, shell or test databases', t => {
    const { root } = fixture(t);
    for (const env of [{}, { DATABASE_URL: NEW_DB }, { NEWSCRAFT_TEST_DATABASE_URL: NEW_DB }, { DATABASE_URL: OLD_DB, NEWSCRAFT_TEST_DATABASE_URL: TEST_DB }]) {
        const resolved = resolveLocalSetup({ root, env });
        assert.equal(resolved.report.ok, false);
        assert.equal(resolved.environment, null);
        assert.equal(resolved.report.checks.find(item => item.name === 'new database').ok, false);
    }
});

test('explicit placeholders and an existing database identity remain blocked', t => {
    const { root } = fixture(t);
    for (const value of ['postgresql://user:password@<database-host>/new', 'postgresql://user:password@placeholder/new',
        NEW_DB.replace('public_synthetic_password', ''), NEW_DB.replace('public_synthetic_password', '[YOUR-PASSWORD]'),
        NEW_DB.replace('public_synthetic_password', '%5BYOUR-PASSWORD%5D'),
        OLD_DB, TEST_DB, OLD_DB.replace('old_fixture_password', 'different_password')]) {
        assert.equal(checkLocal({ root, env: { NEWSCRAFT_SETUP_DATABASE_URL: value } }).ok, false);
    }
});

test('an explicit fresh profile target is accepted but conflicting injection is rejected', t => {
    const { root } = fixture(t);
    const path = join(root, '.env.agent-local');
    writeFileSync(path, readFileSync(path, 'utf8').replace('DATABASE_URL=""', `DATABASE_URL="${NEW_DB}"`));
    assert.equal(checkLocal({ root, env: {} }).ok, true);
    assert.equal(checkLocal({ root, env: { NEWSCRAFT_SETUP_DATABASE_URL: NEW_DB + '_other' } }).ok, false);
});

test('database guard accepts the confirmed direct and session-pooler project shapes', t => {
    const { root } = fixture(t);
    for (const target of [NEW_DB, SESSION_DB, NEW_DB.replace(':5432/', '/')]) {
        assert.equal(checkLocal({ root, env: { NEWSCRAFT_SETUP_DATABASE_URL: target } }).ok, true);
    }
});

test('other projects, transaction poolers and target overrides block start without effects', async t => {
    const { root } = fixture(t);
    for (const target of [
        NEW_DB.replace(PROJECT_REF, 'otherprojectreference'),
        SESSION_DB.replace(PROJECT_REF, 'otherprojectreference'),
        NEW_DB.replace(':5432/', ':6543/'),
        SESSION_DB.replace(':5432/', ':6543/'),
        SESSION_DB.replace(`postgres.${PROJECT_REF}:`, 'postgres:'),
        SESSION_DB.replace('.pooler.supabase.com', '.pooler.supabase.com.attacker.test'),
        NEW_DB.replace('.supabase.co', '.supabase.co.attacker.test'),
        `${NEW_DB}&host=other.example.test`,
        `${SESSION_DB}&user=postgres.otherprojectreference`
    ]) {
        const output = [];
        assert.equal(await runLocal('start', { root, env: { NEWSCRAFT_SETUP_DATABASE_URL: target }, write: line => output.push(line), spawn() { assert.fail('must not spawn'); } }), 1);
        assert.match(output.join('\n'), /BLOCKED: database project/);
        assert.ok(!output.join('\n').includes(target));
    }
});

test('missing, weaker, duplicate or unsupported TLS options block start before connecting', async t => {
    const { root } = fixture(t);
    for (const target of [
        NEW_DB.replace('?sslmode=verify-full', ''),
        NEW_DB.replace('verify-full', 'disable'),
        NEW_DB.replace('verify-full', 'require'),
        NEW_DB.replace('verify-full', 'verify-ca'),
        `${NEW_DB}&sslmode=disable`,
        `${NEW_DB}&sslmode=verify-full`,
        `${NEW_DB}&sslrootcert=%2Fpublic-ca.pem`,
        `${NEW_DB}&sslrootcert=system`
    ]) {
        const output = [];
        assert.equal(await runLocal('start', { root, env: { NEWSCRAFT_SETUP_DATABASE_URL: target }, write: line => output.push(line), spawn() { assert.fail('must not spawn'); } }), 1);
        assert.match(output.join('\n'), /BLOCKED: database project.*sslmode=verify-full/);
        assert.ok(!output.join('\n').includes(target));
    }
});

test('check is passive, redacted and preserves every configuration file', async t => {
    const { root, env } = fixture(t);
    const before = existingFiles(root), profile = readFileSync(join(root, '.env.agent-local'), 'utf8');
    const output = [];
    const code = await runLocal('check', { root, env, write: line => output.push(line), spawn: () => { throw new Error('check must not spawn'); } });
    assert.equal(code, 0);
    const text = output.join('\n');
    for (const value of [KEY, TOKEN, CALLBACK, TENANT, SESSION, STORAGE_KEY, NEW_DB, OLD_DB, TEST_DB, 'storage.example.test', 'never-load-me']) assert.ok(!text.includes(value));
    assert.match(text, /dynamic imports are unverified/);
    assert.match(text, /availability is unverified/);
    assert.match(text, /Terminal\/filesystem and interactive browser adapters require a verified rootless Linux host/);
    assert.match(text, /browser activation also requires a reviewed image and hash-pinned Chromium seccomp profile/);
    assert.deepEqual(existingFiles(root), before);
    assert.equal(readFileSync(join(root, '.env.agent-local'), 'utf8'), profile);
    assert.deepEqual(readdirSync(root).sort(), ['.env.agent-local', '.env.local', 'node_modules', 'services']);
});

test('private resolver environment cannot leak through JSON serialization', t => {
    const { root, env } = fixture(t);
    const value = resolveLocalSetup({ root, env });
    assert.equal(value.environment.DATABASE_URL, NEW_DB);
    assert.equal(value.environment.NEWSCRAFT_TEST_DATABASE_URL, '');
    assert.equal(value.environment.OPENAI_API_KEY, '');
    assert.equal(value.environment.NEWSCRAFT_AGENT_API_TOKEN, TOKEN);
    assert.equal(value.environment.NEWSCRAFT_AGENT_SESSION_TOKEN, TOKEN);
    assert.equal(value.environment.UNRELATED_SECRET, undefined);
    assert.ok(!JSON.stringify(value).includes(TOKEN));
    assert.ok(!JSON.stringify(value).includes(STORAGE_KEY));
    assert.ok(!JSON.stringify(value).includes(NEW_DB));
});

test('mismatched or missing tokens block start without spawning', async t => {
    const { root, env, put } = fixture(t);
    put('services/hermes-chat/.env', `HERMES_AGUI_SESSION_TOKEN=different-synthetic-listener-123456\n`);
    let spawned = false;
    assert.equal(await runLocal('start', { root, env, write() {}, spawn() { spawned = true; } }), 1);
    assert.equal(spawned, false);
    put('.env.local', `DATABASE_URL=${OLD_DB}\n`);
    put('services/hermes-chat/.env', '');
    assert.equal(await runLocal('start', { root, env, write() {}, spawn() { spawned = true; } }), 1);
    assert.equal(spawned, false);
});

test('missing or invalid storage configuration blocks start before spawning', async t => {
    const { root, env } = fixture(t);
    for (const override of [
        { NEWSCRAFT_STORAGE_API_KEY: '' },
        { NEWSCRAFT_STORAGE_BASE_URL: '' },
        { NEWSCRAFT_STORAGE_BASE_URL: 'not-a-url' },
        { NEWSCRAFT_STORAGE_BASE_URL: 'http://storage.example.test' },
        { NEWSCRAFT_STORAGE_BASE_URL: 'https://user:secret@storage.example.test' },
        { NEWSCRAFT_STORAGE_BASE_URL: 'https://storage.example.test/?secret=never-print' }
    ]) {
        let spawned = false;
        assert.equal(await runLocal('start', { root, env: { ...env, ...override }, write() {}, spawn() { spawned = true; } }), 1);
        assert.equal(spawned, false);
    }
    assert.equal(checkLocal({ root, env: { ...env, NEWSCRAFT_STORAGE_BASE_URL: 'http://127.0.0.1:9090' } }).ok, true);
});

test('unverified Node major versions block start with a passive diagnostic', async t => {
    const { root, env } = fixture(t);
    for (const nodeVersion of ['22.0.0', '26.0.0']) {
        const output = [];
        assert.equal(await runLocal('start', { root, env, nodeVersion, write: line => output.push(line), spawn() { assert.fail('must not spawn'); } }), 1);
        assert.match(output.join('\n'), /BLOCKED: Node runtime\. Node 24 is required/);
    }
});

test('check fails closed for unexpected secret fields, invalid budgets and absent owned dependencies', t => {
    const { root, env } = fixture(t);
    const path = join(root, '.env.agent-local'), original = readFileSync(path, 'utf8');
    for (const content of [original + 'OPENAI_API_KEY=sk-do-not-log-this-profile-key\n', original.replace('NEWSCRAFT_AGENT_MAX_COST_USD="4.23"', 'NEWSCRAFT_AGENT_MAX_COST_USD="99"')]) {
        writeFileSync(path, content);
        assert.equal(checkLocal({ root, env }).ok, false);
    }
    writeFileSync(path, original);
    rmSync(join(root, 'services/hermes-chat/.venv-owned/bin/python'));
    assert.equal(checkLocal({ root, env }).checks.find(item => item.name === 'dependency files').ok, false);
});

test('duplicate or malformed approved credentials fail shape checks without printing values', async t => {
    const { root, env, put } = fixture(t);
    for (const value of ['OPENAI_API_KEY=malformed-secret\n', `OPENAI_API_KEY=${KEY}\nOPENAI_API_KEY=${KEY}\n`]) {
        put('services/newsroom-harness/.env.local', value);
        const output = [];
        assert.equal(await runLocal('check', { root, env, write: line => output.push(line) }), 1);
        assert.ok(!output.join('\n').includes(KEY));
        assert.ok(!output.join('\n').includes('malformed-secret'));
    }
});

test('a different Python library version cannot pass the passive owned-runtime check', t => {
    const { root, env, put } = fixture(t);
    rmSync(join(root, 'services/hermes-chat/.venv-owned/lib/python3.11'), { recursive: true });
    for (const name of ['fastapi', 'httpx', 'ddgs', 'uvicorn']) put(`services/hermes-chat/.venv-owned/lib/python3.12/site-packages/${name}/__init__.py`, '');
    put('services/hermes-chat/.venv-owned/lib/python3.12/site-packages/newscraft_agent-0.1.0.dist-info/METADATA', 'synthetic');
    assert.equal(checkLocal({ root, env }).checks.find(item => item.name === 'dependency files').ok, false);
});

test('inherited computer configuration cannot silently activate the guarded Mac launcher', async t => {
    const { root, env } = fixture(t);
    for (const name of ['NEWSCRAFT_EXECUTOR_IMAGE', 'NEWSCRAFT_EXECUTOR_SOCKET', 'NEWSCRAFT_EXECUTOR_DOCKER_BIN',
        'NEWSCRAFT_BROWSER_IMAGE', 'NEWSCRAFT_BROWSER_SECCOMP_PROFILE', 'NEWSCRAFT_BROWSER_SECCOMP_SHA256']) {
        const output = [];
        assert.equal(await runLocal('start', { root, env: { ...env, [name]: 'unapproved-fixture-value' },
            write: line => output.push(line), spawn() { assert.fail('must not spawn'); } }), 1);
        assert.match(output.join('\n'), /BLOCKED: computer configuration/);
        assert.ok(!output.join('\n').includes('unapproved-fixture-value'));
    }
});

test('only explicit start delegates to dev-all with fresh DB and protected empty overrides', async t => {
    const { root, env } = fixture(t), before = existingFiles(root);
    const calls = [];
    const code = await runLocal('start', { root, env, write() {}, spawn(command, args, options) {
        calls.push({ command, args, options });
        const child = new EventEmitter(); child.kill = () => {};
        queueMicrotask(() => child.emit('exit', 0));
        return child;
    } });
    assert.equal(code, 0); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [join(root, 'scripts/dev-all.mjs')]);
    const child = calls[0].options.env;
    assert.equal(child.DATABASE_URL, NEW_DB);
    assert.equal(child.NEWSCRAFT_TEST_DATABASE_URL, '');
    assert.equal(child.OPENAI_API_KEY, '');
    assert.equal(child.NEWSCRAFT_AGENT_CREDENTIAL_FILE, join(root, 'services/newsroom-harness/.env.local'));
    assert.equal(child.NEWSCRAFT_SETUP_DATABASE_URL, '');
    assert.equal(child.OPENAI_BASE_URL, 'https://api.openai.com/v1');
    assert.equal(child.NEWSCRAFT_STORAGE_PROVIDER, 'vps');
    assert.equal(child.NEWSCRAFT_STORAGE_API_KEY, STORAGE_KEY);
    assert.deepEqual(existingFiles(root), before);
});

test('start errors and invalid commands reveal no exception values and fail closed', async t => {
    const { root, env } = fixture(t), output = [];
    assert.equal(await runLocal('start', { root, env, write: line => output.push(line), spawn() { throw new Error(`${NEW_DB} ${TOKEN}`); } }), 1);
    assert.ok(!output.join('\n').includes(NEW_DB)); assert.ok(!output.join('\n').includes(TOKEN));
    assert.equal(await runLocal('--migrate', { root, env, write() {}, spawn() { assert.fail('must not spawn'); } }), 2);
});

test('explicit DeepSeek selection uses only its approved file key and preserves existing files', t => {
    const { root, env, put } = fixture(t);
    put('services/newsroom-harness/.env.local', `DEEPSEEK_API_KEY=${KEY}\nUNRELATED_SECRET=never-load-me\n`);
    const before = existingFiles(root), profile = readFileSync(join(root, '.env.agent-local'), 'utf8');
    const resolved = resolveLocalSetup({ root, provider: 'deepseek', env: { ...env,
        NEWSCRAFT_AGENT_MODEL_PROVIDER: 'openai', NEWSCRAFT_AGENT_MODEL: 'unapproved-model',
        OPENAI_BASE_URL: 'https://unapproved.example.test', DEEPSEEK_BASE_URL: 'https://unapproved.example.test',
        OPENAI_API_KEY: 'sk-unapproved-openai-key-123456', ANTHROPIC_API_KEY: 'sk-unapproved-anthropic-key-123456',
        DEEPSEEK_API_KEY: 'sk-unapproved-deepseek-key-123456' } });
    assert.equal(resolved.report.ok, true);
    const child = resolved.environment;
    assert.equal(child.NEWSCRAFT_AGENT_MODEL_PROVIDER, 'deepseek');
    assert.equal(child.NEWSCRAFT_AGENT_MODEL, 'deepseek-flash');
    assert.equal(child.DEEPSEEK_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.equal(child.NEWSCRAFT_AGENT_MAX_COST_USD, '0.06');
    assert.equal(child.NEWSCRAFT_AGENT_INPUT_PRICE_CEILING, '0.30');
    assert.equal(child.NEWSCRAFT_AGENT_OUTPUT_PRICE_CEILING, '1.20');
    assert.equal(child.NEWSCRAFT_AGENT_WEB_PROVIDER, 'public');
    assert.equal(child.NEWSCRAFT_AGENT_CREDENTIAL_FILE, join(root, 'services/newsroom-harness/.env.local'));
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY']) assert.equal(child[name], '');
    assert.equal(child.UNRELATED_SECRET, undefined);
    assert.ok(!JSON.stringify(resolved).includes(KEY));
    assert.ok(!JSON.stringify(resolved).includes(NEW_DB));
    assert.equal(Object.getOwnPropertyDescriptor(resolved, 'environment').enumerable, false);
    assert.deepEqual(existingFiles(root), before);
    assert.equal(readFileSync(join(root, '.env.agent-local'), 'utf8'), profile);
});

test('DeepSeek can be selected by a reviewed local profile without CLI overrides', t => {
    const { root, env, put } = fixture(t);
    put('services/newsroom-harness/.env.local', `DEEPSEEK_API_KEY=${KEY}\n`);
    put('.env.agent-local', Object.entries(localDefaults(root, 'deepseek')).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'));
    const resolved = resolveLocalSetup({ root, env });
    assert.equal(resolved.report.ok, true);
    assert.equal(resolved.environment.NEWSCRAFT_AGENT_MODEL_PROVIDER, 'deepseek');
    assert.equal(resolved.environment.NEWSCRAFT_AGENT_MAX_COST_USD, '0.06');
});

test('missing, wrong-provider, malformed and duplicate DeepSeek references block start without leaking', async t => {
    const { root, env, put } = fixture(t);
    for (const value of ['', `OPENAI_API_KEY=${KEY}\n`, `ANTHROPIC_API_KEY=${KEY}\n`,
        'DEEPSEEK_API_KEY=malformed-secret\n', 'DEEPSEEK_API_KEY="sk-secret with spaces"\n',
        `DEEPSEEK_API_KEY=${KEY}\nexport DEEPSEEK_API_KEY=${KEY}\n`]) {
        put('services/newsroom-harness/.env.local', value);
        const output = [];
        const code = await runLocal('start', { root, provider: 'deepseek',
            env: { ...env, DEEPSEEK_API_KEY: KEY, OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: KEY },
            write: line => output.push(line), spawn() { assert.fail('must not spawn without selected file credential'); } });
        assert.equal(code, 1);
        assert.match(output.join('\n'), /BLOCKED: approved credential.*DEEPSEEK_API_KEY/);
        for (const sensitive of [KEY, 'malformed-secret', 'sk-secret with spaces', NEW_DB]) assert.ok(!output.join('\n').includes(sensitive));
    }
});

test('selected-key grammar rejects malformed declarations that permissive dotenv parsing accepts', async t => {
    const { root, env, put } = fixture(t);
    for (const [provider, name] of [['openai', 'OPENAI_API_KEY'], ['deepseek', 'DEEPSEEK_API_KEY']]) {
        for (const value of [
            `${name}=${KEY}\n${name}\n`, `${name}=${KEY}\nexport ${name}\n`,
            `${name}="${KEY}\n`, `${name}='${KEY}\n`, `${name}=${KEY}"\n`,
            `${name}="${KEY}'\n`, `${name}=${KEY}'embedded\n`,
            `${name}="${KEY} with spaces"\n`, `${name}=${KEY} # comment\n`,
            `${name}=${KEY}\x1fhidden\n`, `${name}=\n`, `${name}\n`,
            `\ufeff${name}=${KEY}\n`, Buffer.concat([Buffer.from(`${name}=${KEY}`), Buffer.from([0xff])])
        ]) {
            put('services/newsroom-harness/.env.local', value);
            const output = [];
            assert.equal(await runLocal('start', { root, env, provider, write: line => output.push(line),
                spawn() { assert.fail('malformed selected credentials must not start'); } }), 1);
            assert.match(output.join('\n'), /BLOCKED: approved credential/);
            assert.ok(!output.join('\n').includes(KEY));
        }
    }
});

test('selected-key grammar accepts exactly one plain or correctly quoted declaration', t => {
    const { root, env, put } = fixture(t);
    for (const [provider, name] of [['openai', 'OPENAI_API_KEY'], ['deepseek', 'DEEPSEEK_API_KEY']]) {
        for (const value of [`${name}=${KEY}\n`, `${name}="${KEY}"\n`, `${name}='${KEY}'\n`,
            `  export ${name} = "${KEY}"  \r\n`, `# ${name}=ignored-comment\n${name}=${KEY}\nUNRELATED_SECRET=ignored\n`]) {
            put('services/newsroom-harness/.env.local', value);
            assert.equal(checkLocal({ root, env, provider }).ok, true);
        }
    }
});

test('DeepSeek rejects retired models and unsupported profile endpoints', t => {
    const { root, env, put } = fixture(t);
    put('services/newsroom-harness/.env.local', `DEEPSEEK_API_KEY=${KEY}\n`);
    const defaults = localDefaults(root, 'deepseek');
    for (const override of [
        { NEWSCRAFT_AGENT_MODEL: 'deepseek-chat' }, { NEWSCRAFT_AGENT_MODEL: 'deepseek-reasoner' },
        { NEWSCRAFT_AGENT_MODEL: 'gpt-6-astra' }, { DEEPSEEK_BASE_URL: 'https://api.deepseek.com' },
        { DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic/v1' },
        { DEEPSEEK_BASE_URL: 'https://api.deepseek.com.attacker.test/anthropic' },
        { DEEPSEEK_BASE_URL: 'http://api.deepseek.com/anthropic' }
    ]) {
        put('.env.agent-local', Object.entries({ ...defaults, ...override }).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'));
        const resolved = resolveLocalSetup({ root, env });
        assert.equal(resolved.report.ok, false);
        assert.equal(resolved.report.checks.find(item => item.name === 'local configuration').ok, false);
    }
});

test('DeepSeek enforces its peak price floors and bounded acceptance reservation cap', t => {
    const { root, env, put } = fixture(t);
    put('services/newsroom-harness/.env.local', `DEEPSEEK_API_KEY=${KEY}\n`);
    const defaults = localDefaults(root, 'deepseek');
    assert.equal((120000 * 0.30 + 8 * 2048 * 1.20) / 1e6, 0.0556608);
    for (const override of [
        { NEWSCRAFT_AGENT_INPUT_PRICE_CEILING: '0.2999' }, { NEWSCRAFT_AGENT_OUTPUT_PRICE_CEILING: '1.1999' },
        { NEWSCRAFT_AGENT_INPUT_PRICE_CEILING: 'NaN' }, { NEWSCRAFT_AGENT_OUTPUT_PRICE_CEILING: 'Infinity' },
        { NEWSCRAFT_AGENT_MAX_COST_USD: '0.060001' }, { NEWSCRAFT_AGENT_MAX_COST_USD: '4.23' },
        { NEWSCRAFT_AGENT_MAX_STEPS: '9' }, { NEWSCRAFT_AGENT_MAX_INPUT_TOKENS: '120001' },
        { NEWSCRAFT_AGENT_MAX_OUTPUT_TOKENS: '2049' }, { NEWSCRAFT_AGENT_MAX_SECONDS: '181' }
    ]) {
        put('.env.agent-local', Object.entries({ ...defaults, ...override }).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'));
        const report = checkLocal({ root, env });
        assert.equal(report.ok, false);
        assert.equal(report.checks.find(item => item.name === 'budgets').ok, false);
    }
});

test('DeepSeek CLI selection preserves database and credential-reference guards', async t => {
    const { root, env, put } = fixture(t);
    put('services/newsroom-harness/.env.local', `DEEPSEEK_API_KEY=${KEY}\n`);
    const profile = readFileSync(join(root, '.env.agent-local'), 'utf8');
    for (const target of [OLD_DB, TEST_DB, NEW_DB.replace('verify-full', 'require'), NEW_DB.replace(PROJECT_REF, 'otherprojectreference')]) {
        assert.equal(await runLocal('start', { root, provider: 'deepseek', env: { ...env, NEWSCRAFT_SETUP_DATABASE_URL: target },
            write() {}, spawn() { assert.fail('provider selection cannot bypass database guard'); } }), 1);
    }
    assert.equal(readFileSync(join(root, '.env.agent-local'), 'utf8'), profile);
    put('.env.agent-local', profile.replace('NEWSCRAFT_AGENT_CREDENTIAL_FILE=', '#NEWSCRAFT_AGENT_CREDENTIAL_FILE=') + '\nNEWSCRAFT_AGENT_CREDENTIAL_FILE="/unapproved/credential"\n');
    assert.equal(await runLocal('start', { root, provider: 'deepseek', env, write() {},
        spawn() { assert.fail('provider selection cannot bypass credential-file guard'); } }), 1);
});

test('DeepSeek check stays passive and explicit start passes the selected bounded profile', async t => {
    const { root, env, put } = fixture(t);
    put('services/newsroom-harness/.env.local', `DEEPSEEK_API_KEY=${KEY}\n`);
    const before = existingFiles(root), profile = readFileSync(join(root, '.env.agent-local'), 'utf8');
    assert.equal(await runLocal('check', { root, env, provider: 'deepseek', write() {}, spawn() { assert.fail('check must be passive'); } }), 0);
    let calls = 0;
    assert.equal(await runLocal('start', { root, env, provider: 'deepseek', write() {}, spawn(command, args, options) {
        calls++;
        assert.equal(options.env.NEWSCRAFT_AGENT_MODEL_PROVIDER, 'deepseek');
        assert.equal(options.env.NEWSCRAFT_AGENT_MODEL, 'deepseek-flash');
        assert.equal(options.env.NEWSCRAFT_AGENT_MAX_COST_USD, '0.06');
        assert.equal(options.env.DATABASE_URL, NEW_DB);
        assert.equal(options.env.DEEPSEEK_API_KEY, '');
        const child = new EventEmitter(); child.kill = () => {};
        queueMicrotask(() => child.emit('exit', 0)); return child;
    } }), 0);
    assert.equal(calls, 1);
    assert.deepEqual(existingFiles(root), before);
    assert.equal(readFileSync(join(root, '.env.agent-local'), 'utf8'), profile);
});

test('provider CLI parsing is strict and unsupported selection is redacted', async t => {
    const { root, env } = fixture(t);
    assert.deepEqual(parseLocalArguments(['check', '--provider', 'deepseek']), { command: 'check', provider: 'deepseek' });
    assert.deepEqual(parseLocalArguments(['start', '--provider', 'deepseek']), { command: 'start', provider: 'deepseek' });
    assert.deepEqual(parseLocalArguments(['check']), { command: 'check', provider: undefined });
    for (const args of [[], ['check', '--provider'], ['check', '--provider=deepseek'], ['check', '--provider', 'deepseek', '--start']]) {
        assert.deepEqual(parseLocalArguments(args), { command: '', provider: undefined });
    }
    const output = [];
    assert.equal(await runLocal('start', { root, env, provider: 'unapproved-secret-provider', write: line => output.push(line),
        spawn() { assert.fail('must not spawn unsupported provider'); } }), 1);
    assert.ok(!output.join('\n').includes('unapproved-secret-provider'));
    assert.match(output.join('\n'), /BLOCKED: model provider/);
    assert.equal(await runLocal('prepare', { root, env, provider: 'deepseek', write() {} }), 2);
});
