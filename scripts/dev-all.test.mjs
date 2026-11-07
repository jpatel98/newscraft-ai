import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configureAgentProviderCredentials, listenerConflictMessage, parseLocalAgentUrl } from './dev-all.mjs';

const REFERENCE = '/synthetic/repo/services/newsroom-harness/.env.local';
const KEY = 'sk-public-synthetic-fixture-not-a-real-key';

test('DeepSeek with public search selects the existing reference without requiring an OpenAI key', () => {
    const environment = { NEWSCRAFT_AGENT_MODEL_PROVIDER: 'deepseek', NEWSCRAFT_AGENT_WEB_PROVIDER: 'public' };
    const paths = [];
    configureAgentProviderCredentials(environment, { rootDirectory: '/synthetic/repo', fileExists(path) {
        paths.push(path); return path === REFERENCE;
    } });
    assert.equal(environment.NEWSCRAFT_AGENT_CREDENTIAL_FILE, REFERENCE);
    assert.deepEqual(paths, [REFERENCE]);
    assert.equal(environment.DEEPSEEK_API_KEY, undefined);
    assert.equal(environment.OPENAI_API_KEY, undefined);
});

test('a direct DeepSeek key can start without an OpenAI credential or credential file', () => {
    const environment = { NEWSCRAFT_AGENT_MODEL_PROVIDER: 'deepseek', NEWSCRAFT_AGENT_WEB_PROVIDER: 'public', DEEPSEEK_API_KEY: KEY };
    configureAgentProviderCredentials(environment, { fileExists() { assert.fail('direct selected-provider key needs no reference probe'); } });
    assert.equal(environment.OPENAI_API_KEY, undefined);
});

test('other provider keys cannot satisfy DeepSeek and error details stay redacted', () => {
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
        assert.throws(() => configureAgentProviderCredentials({ NEWSCRAFT_AGENT_MODEL_PROVIDER: 'deepseek',
            NEWSCRAFT_AGENT_WEB_PROVIDER: 'public', [name]: KEY }, { fileExists: () => false }), error => {
            assert.match(error.message, /requires DEEPSEEK_API_KEY/);
            assert.ok(!error.message.includes(KEY)); return true;
        });
    }
});

test('explicit optional OpenAI search requires its own credential in addition to DeepSeek', () => {
    const environment = { NEWSCRAFT_AGENT_MODEL_PROVIDER: 'deepseek', NEWSCRAFT_AGENT_WEB_PROVIDER: 'openai', DEEPSEEK_API_KEY: KEY };
    assert.throws(() => configureAgentProviderCredentials(environment, { fileExists: () => false }), /requires OPENAI_API_KEY/);
    environment.OPENAI_API_KEY = KEY;
    configureAgentProviderCredentials(environment, { fileExists() { assert.fail('direct keys need no file probe'); } });
});

test('OpenAI and Anthropic keep their provider-specific credential requirements', () => {
    for (const [provider, name] of [['openai', 'OPENAI_API_KEY'], ['anthropic', 'ANTHROPIC_API_KEY']]) {
        configureAgentProviderCredentials({ NEWSCRAFT_AGENT_MODEL_PROVIDER: provider, [name]: KEY }, { fileExists: () => false });
        assert.throws(() => configureAgentProviderCredentials({ NEWSCRAFT_AGENT_MODEL_PROVIDER: provider }, { fileExists: () => false }), new RegExp(`requires ${name}`));
    }
});

test('Anthropic cannot use a credential file in place of its environment key, including OpenAI search', () => {
    for (const webProvider of ['public', 'openai']) {
        const environment = { NEWSCRAFT_AGENT_MODEL_PROVIDER: 'anthropic', NEWSCRAFT_AGENT_WEB_PROVIDER: webProvider,
            NEWSCRAFT_AGENT_CREDENTIAL_FILE: REFERENCE, OPENAI_API_KEY: KEY };
        assert.throws(() => configureAgentProviderCredentials(environment, { fileExists: () => true }), /requires ANTHROPIC_API_KEY in the environment/);
        environment.ANTHROPIC_API_KEY = '   ';
        assert.throws(() => configureAgentProviderCredentials(environment, { fileExists: () => true }), /requires ANTHROPIC_API_KEY in the environment/);
        environment.ANTHROPIC_API_KEY = KEY;
        configureAgentProviderCredentials(environment, { fileExists: () => true });
    }
});

test('explicit credential references are preserved and unsupported providers fail closed', () => {
    const environment = { NEWSCRAFT_AGENT_MODEL_PROVIDER: 'deepseek', NEWSCRAFT_AGENT_CREDENTIAL_FILE: '/synthetic/approved/reference' };
    configureAgentProviderCredentials(environment, { fileExists: path => path === '/synthetic/approved/reference' });
    assert.equal(environment.NEWSCRAFT_AGENT_CREDENTIAL_FILE, '/synthetic/approved/reference');
    assert.throws(() => configureAgentProviderCredentials({ NEWSCRAFT_AGENT_MODEL_PROVIDER: 'unsupported-secret-value' }), error => {
        assert.equal(error.message, 'Unsupported agent model provider.'); return true;
    });
});

test('occupied-port diagnostics never print another process command or credentials', () => {
    const message = listenerConflictMessage({ name: 'Agent', port: 8000 }, {
        pid: 1234, command: `python --api-key=${KEY} --database=postgres://fixture:private@localhost/db`
    });
    assert.equal(message, '- Agent port 8000: PID 1234');
    assert.ok(!message.includes(KEY));
    assert.ok(!message.includes('postgres://'));
});

test('local worker URLs reject credentials and remote destinations without reflecting input', () => {
    assert.deepEqual(parseLocalAgentUrl('http://127.0.0.1:8000'), { origin: 'http://127.0.0.1:8000', port: 8000 });
    for (const value of [`http://fixture:${KEY}@127.0.0.1:8000`, 'https://remote.example.test', `http://127.0.0.1:8000/?key=${KEY}`]) {
        assert.throws(() => parseLocalAgentUrl(value), error => {
            assert.ok(!error.message.includes(KEY));
            assert.ok(!error.message.includes(value));
            return true;
        });
    }
});
