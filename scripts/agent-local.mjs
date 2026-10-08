#!/usr/bin/env node
/** Passive setup by default. Only the explicit `start` command runs dev-all. */
import { spawn as spawnProcess } from 'node:child_process';
import { once } from 'node:events';
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = '.env.agent-local';
const CREDENTIAL = 'services/newsroom-harness/.env.local';
const PYTHON = 'services/hermes-chat/.venv-owned/bin/python';

const MODEL_PROFILES = {
    openai: {
        NEWSCRAFT_AGENT_MODEL_PROVIDER: 'openai', NEWSCRAFT_AGENT_MODEL: 'gpt-6-astra',
        NEWSCRAFT_AGENT_INPUT_PRICE_CEILING: '25', NEWSCRAFT_AGENT_OUTPUT_PRICE_CEILING: '75',
        NEWSCRAFT_AGENT_MAX_COST_USD: '4.23'
    },
    deepseek: {
        NEWSCRAFT_AGENT_MODEL_PROVIDER: 'deepseek', NEWSCRAFT_AGENT_MODEL: 'deepseek-flash',
        NEWSCRAFT_AGENT_INPUT_PRICE_CEILING: '0.30', NEWSCRAFT_AGENT_OUTPUT_PRICE_CEILING: '1.20',
        NEWSCRAFT_AGENT_MAX_COST_USD: '0.06'
    }
};

export function localDefaults(root = ROOT, provider = 'openai') {
    if (!Object.hasOwn(MODEL_PROFILES, provider)) throw new Error('Unsupported local model provider.');
    return {
        DATABASE_URL: '', NEWSCRAFT_AUTH_PROVIDER: 'postgres', NEWSCRAFT_STORAGE_PROVIDER: 'vps',
        NEWSCRAFT_SETUP_PROJECT_REF: 'ygsiifvjzdazfxflmpjq',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
        NEWSCRAFT_AGENT_WEB_PROVIDER: 'public', NEWSCRAFT_AGENT_BROWSER_PROVIDER: 'disabled',
        NEWSCRAFT_AGENT_MAX_STEPS: '8', NEWSCRAFT_AGENT_MAX_INPUT_TOKENS: '120000',
        NEWSCRAFT_AGENT_MAX_OUTPUT_TOKENS: '2048', NEWSCRAFT_AGENT_MAX_SECONDS: '180',
        ...MODEL_PROFILES[provider],
        NEWSCRAFT_AGENT_MAX_ACTIVE_RUNS: '1', NEWSCRAFT_AGENT_MAX_ACTIVE_RUNS_PER_TENANT: '1',
        NEWSCRAFT_AGENT_MAX_QUEUED_RUNS: '1', NEWSCRAFT_AGENT_MAX_QUEUED_RUNS_PER_TENANT: '1',
        NEWSCRAFT_AGENT_HOST: '127.0.0.1', NEWSCRAFT_AGENT_PORT: '8000', NEWSCRAFT_AGENT_PUBLIC_HOST: '',
        NEWSCRAFT_AGENT_URL: 'http://127.0.0.1:8000', NEWSCRAFT_AGENT_RUN_API_URL: 'http://127.0.0.1:3001/api/internal/hermes/runs',
        NEWSCRAFT_AGENT_STATE_HOME: resolve(root, '.data/agent-local/state'),
        NEWSCRAFT_AGENT_WORKSPACE: resolve(root, '.data/agent-local/workspace'),
        NEWSCRAFT_AGENT_BIN: resolve(root, PYTHON), NEWSCRAFT_AGENT_CREDENTIAL_FILE: resolve(root, CREDENTIAL)
    };
}

export function prepareLocal({ root = ROOT } = {}) {
    const path = resolve(root, PROFILE);
    const content = '# Local nonsecret defaults. Existing credentials stay in their original files.\n' +
        '# Enter the initialized project\'s actual Connect URL privately in DATABASE_URL below.\n' +
        '# The only database URL query option is sslmode=verify-full.\n' +
        '# If extra public CA trust is needed, configure NODE_EXTRA_CA_CERTS before launching Node.\n' +
        '# No services, imports, network probes or migrations run during prepare/check.\n' +
        '# Optional computer access requires the reviewed rootless Linux executor.\n' +
        Object.entries(localDefaults(root)).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
    try {
        writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
        return { ok: true, message: 'Created the nonsecret local profile. New database configuration is still required.' };
    } catch (cause) {
        if (cause?.code === 'EEXIST') return { ok: true, message: 'Existing local profile preserved.' };
        return { ok: false, message: 'The local profile could not be created; no existing file was replaced.' };
    }
}

function readEnvironment(path, required = false) {
    if (!existsSync(path)) {
        if (required) throw new Error('missing');
        return {};
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('invalid file');
    return parse(readFileSync(path));
}

function selectedCredentialReady(path, keyName) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return false;
    // Match the worker's selected-key grammar rather than dotenv's permissive
    // parsing: malformed or bare declarations count, and quotes must be paired.
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
    const strip = value => value.replace(/^[\p{White_Space}\x1c-\x1f]+|[\p{White_Space}\x1c-\x1f]+$/gu, '');
    const matches = [];
    for (let line of content.split(/\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/)) {
        line = strip(line);
        if (line.startsWith('export ')) line = strip(line.slice(7));
        const separator = line.indexOf('=');
        const name = separator === -1 ? line : line.slice(0, separator);
        if (strip(name) === keyName) matches.push({ separator, value: separator === -1 ? '' : strip(line.slice(separator + 1)) });
    }
    if (matches.length !== 1 || matches[0].separator === -1) return false;
    let { value } = matches[0];
    if (value.length >= 2 && value[0] === value.at(-1) && ['"', "'"].includes(value[0])) value = value.slice(1, -1);
    return /^sk-[^\s\x1c-\x1f\x85'\"]{20,}$/.test(value);
}

function databaseIdentity(value) {
    if (!value || /[<>\s]|placeholder|change.?me|new-project-ref/i.test(value)) return null;
    try {
        const url = new URL(value);
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2 || url.hash) return null;
        return [url.hostname.toLowerCase(), url.port || '5432', decodeURIComponent(url.username), url.pathname].join('|');
    } catch { return null; }
}

// This guard is only for this local setup target, not the product's database adapter.
function setupProjectMatches(value, projectRef) {
    try {
        const url = new URL(value);
        const password = decodeURIComponent(url.password);
        if (!password || /^[\[<]?(?:YOUR[-_ ]?)?PASSWORD[\]>]?$/i.test(password)) return false;
        if ((url.port || '5432') !== '5432') return false;
        const sslModes = url.searchParams.getAll('sslmode');
        if (sslModes.length !== 1 || sslModes[0] !== 'verify-full') return false;
        // Connection-string query overrides must not change the checked target.
        if ([...url.searchParams.keys()].some(key => key !== 'sslmode')) return false;
        const hostname = url.hostname.toLowerCase();
        if (hostname === `db.${projectRef}.supabase.co`) return true;
        const username = decodeURIComponent(url.username);
        return hostname.endsWith('.pooler.supabase.com') &&
            hostname.length > '.pooler.supabase.com'.length &&
            username.length > projectRef.length + 1 && username.endsWith(`.${projectRef}`);
    } catch { return false; }
}

function storageUrlReady(value) {
    if (!value || /[<>\s]|placeholder|change.?me/i.test(value)) return false;
    try {
        const url = new URL(value);
        const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
        return Boolean((url.protocol === 'https:' || localHttp) && url.hostname &&
            !url.username && !url.password && !url.search && !url.hash);
    } catch { return false; }
}

function dependencyFilesReady(root) {
    try {
        const python = resolve(root, PYTHON);
        accessSync(python, constants.X_OK);
        const home = resolve(root, 'services/hermes-chat/.venv-owned');
        if (!/include-system-site-packages\s*=\s*false/i.test(readFileSync(join(home, 'pyvenv.cfg'), 'utf8'))) return false;
        const versions = readdirSync(join(home, 'lib')).filter(name => /^python3\.\d+$/.test(name));
        // Package files for a different interpreter do not satisfy the locked
        // worker contract. This remains a passive check: never execute Python.
        return versions.length === 1 && versions[0] === 'python3.11' && versions.every(version => {
            const packages = join(home, 'lib', version, 'site-packages');
            return ['fastapi', 'httpx', 'ddgs', 'uvicorn'].every(name => existsSync(join(packages, name, '__init__.py'))) &&
                readdirSync(packages).some(name => /^newscraft_agent-.+\.dist-info$/.test(name));
        }) && existsSync(resolve(root, 'node_modules/.bin/vite'));
    } catch { return false; }
}

/** No I/O beyond bounded local file reads. The environment is private and
 * deliberately non-enumerable so JSON/logging the result cannot print secrets.
 * A future authorized migration wrapper can explicitly use .environment. */
export function resolveLocalSetup({ root = ROOT, env = process.env, nodeVersion = process.versions.node, provider } = {}) {
    const checks = [];
    const check = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };
    const result = environment => {
        const report = { ok: checks.every(item => item.ok), checks, limitations: [
            'Configured ports: app 127.0.0.1:3001 and worker 127.0.0.1:8000; availability is unverified (no probes).',
            'Interpreter/package files are checked; dynamic imports are unverified (no subprocesses).',
            'This checker does not verify database connectivity/schema, provider access or storage.',
            'Terminal/filesystem and interactive browser adapters require a verified rootless Linux host; browser activation also requires a reviewed image and hash-pinned Chromium seccomp profile.'
        ] };
        return Object.defineProperty({ report }, 'environment', { value: report.ok ? environment : null, enumerable: false });
    };
    check('Node runtime', /^24\./.test(nodeVersion), 'Node 24 is required for the verified workspace dependencies; prepend the installed fnm Node 24 bin directory to PATH.');
    let app, service, profile;
    try {
        app = readEnvironment(resolve(root, '.env.local'));
        service = readEnvironment(resolve(root, 'services/hermes-chat/.env'));
        profile = readEnvironment(resolve(root, PROFILE), true);
    } catch {
        check('files', false, 'Required configuration files are missing, unreadable or invalid; values were not logged.');
        return result(null);
    }
    check('files', true, 'Existing files read in memory; no files rewritten.');
    const selectedProvider = provider ?? profile.NEWSCRAFT_AGENT_MODEL_PROVIDER ?? 'openai';
    const supportedProvider = Object.hasOwn(MODEL_PROFILES, selectedProvider);
    check('model provider', supportedProvider, 'The guarded local profile supports OpenAI or DeepSeek with its own approved credential reference.');
    const defaults = localDefaults(root, supportedProvider ? selectedProvider : 'openai');
    const allowed = new Set(Object.keys(defaults));
    check('profile', Object.keys(profile).every(key => allowed.has(key)), 'The profile accepts only documented local defaults and an explicit database target.');
    // Explicit CLI selection replaces only the reviewed model profile in memory.
    // Database, credential-file and local-listener guards still inspect the profile.
    const config = { ...defaults, ...profile, ...(provider !== undefined && supportedProvider ? MODEL_PROFILES[provider] : {}) };
    const fixed = ['NEWSCRAFT_SETUP_PROJECT_REF', 'NEWSCRAFT_AUTH_PROVIDER', 'NEWSCRAFT_STORAGE_PROVIDER', 'NEWSCRAFT_AGENT_MODEL_PROVIDER', 'NEWSCRAFT_AGENT_MODEL', 'OPENAI_BASE_URL', 'DEEPSEEK_BASE_URL',
        'NEWSCRAFT_AGENT_WEB_PROVIDER', 'NEWSCRAFT_AGENT_BROWSER_PROVIDER', 'NEWSCRAFT_AGENT_HOST', 'NEWSCRAFT_AGENT_PORT',
        'NEWSCRAFT_AGENT_PUBLIC_HOST', 'NEWSCRAFT_AGENT_URL', 'NEWSCRAFT_AGENT_RUN_API_URL',
        'NEWSCRAFT_AGENT_MAX_ACTIVE_RUNS', 'NEWSCRAFT_AGENT_MAX_ACTIVE_RUNS_PER_TENANT',
        'NEWSCRAFT_AGENT_MAX_QUEUED_RUNS', 'NEWSCRAFT_AGENT_MAX_QUEUED_RUNS_PER_TENANT',
        'NEWSCRAFT_AGENT_STATE_HOME', 'NEWSCRAFT_AGENT_WORKSPACE', 'NEWSCRAFT_AGENT_BIN', 'NEWSCRAFT_AGENT_CREDENTIAL_FILE'];
    check('local configuration', fixed.every(key => config[key] === defaults[key]), 'Uses the owned interpreter, approved key reference and local listeners; no legacy runtime fallback.');
    const limits = { NEWSCRAFT_AGENT_MAX_STEPS: [1, 8], NEWSCRAFT_AGENT_MAX_INPUT_TOKENS: [1000, 120000],
        NEWSCRAFT_AGENT_MAX_OUTPUT_TOKENS: [256, 2048], NEWSCRAFT_AGENT_MAX_COST_USD: [0.001, Number(defaults.NEWSCRAFT_AGENT_MAX_COST_USD)], NEWSCRAFT_AGENT_MAX_SECONDS: [10, 180] };
    check('budgets', Object.entries(limits).every(([key, [min, max]]) => {
        const value = Number(config[key]); return Number.isFinite(value) && value >= min && value <= max &&
            (key === 'NEWSCRAFT_AGENT_MAX_COST_USD' || Number.isInteger(value));
    }) && Number(config.NEWSCRAFT_AGENT_INPUT_PRICE_CEILING) >= Number(defaults.NEWSCRAFT_AGENT_INPUT_PRICE_CEILING) && Number(config.NEWSCRAFT_AGENT_INPUT_PRICE_CEILING) <= 100000 &&
        Number(config.NEWSCRAFT_AGENT_OUTPUT_PRICE_CEILING) >= Number(defaults.NEWSCRAFT_AGENT_OUTPUT_PRICE_CEILING) && Number(config.NEWSCRAFT_AGENT_OUTPUT_PRICE_CEILING) <= 100000,
    `Reviewed ceilings and local reservations are configured; at most $${defaults.NEWSCRAFT_AGENT_MAX_COST_USD} per run, not a provider billing guarantee.`);

    const supplied = (env.NEWSCRAFT_SETUP_DATABASE_URL || profile.DATABASE_URL || '').trim();
    const identity = databaseIdentity(supplied);
    const prior = [app, service, env].flatMap(source => [source.DATABASE_URL, source.NEWSCRAFT_TEST_DATABASE_URL]).map(databaseIdentity).filter(Boolean);
    const explicitConflict = env.NEWSCRAFT_SETUP_DATABASE_URL?.trim() && profile.DATABASE_URL?.trim() && env.NEWSCRAFT_SETUP_DATABASE_URL.trim() !== profile.DATABASE_URL.trim();
    check('new database', Boolean(identity && !prior.includes(identity) && !explicitConflict),
        'Requires an explicit new target in the profile or NEWSCRAFT_SETUP_DATABASE_URL; old/test database fallback is forbidden.');
    check('database project', Boolean(identity && setupProjectMatches(supplied, config.NEWSCRAFT_SETUP_PROJECT_REF)),
        'Use the confirmed project\'s actual Connect URL: direct host or matching session pooler, port 5432, and only sslmode=verify-full. Additional public CA trust, if needed, must use NODE_EXTRA_CA_CERTS before launching Node.');

    const sources = [app, service, env];
    const inherited = { ...app, ...service, ...env };
    const computerKeys = ['NEWSCRAFT_EXECUTOR_IMAGE', 'NEWSCRAFT_EXECUTOR_SOCKET', 'NEWSCRAFT_EXECUTOR_DOCKER_BIN',
        'NEWSCRAFT_BROWSER_IMAGE', 'NEWSCRAFT_BROWSER_SECCOMP_PROFILE', 'NEWSCRAFT_BROWSER_SECCOMP_SHA256'];
    check('computer configuration', computerKeys.every(key => !(inherited[key] || '').trim()),
        'This guarded Mac profile requires computer configuration to be absent; Linux executor acceptance is a separate host decision.');
    const storageUrl = (inherited.NEWSCRAFT_STORAGE_BASE_URL || '').trim();
    const storageKey = (inherited.NEWSCRAFT_STORAGE_API_KEY || '').trim();
    check('storage URL', storageUrlReady(storageUrl), 'Existing VPS storage URL must have a usable HTTPS or loopback HTTP shape; endpoint access is unverified.');
    check('storage credential', Boolean(storageKey && !/\s/.test(storageKey)), 'Existing VPS storage API key must be present; its value and validity are not disclosed or tested.');
    function token(name, keys, minimum) {
        const values = new Set(sources.flatMap(source => keys.map(key => (source[key] || '').trim())).filter(Boolean));
        const value = values.size === 1 ? [...values][0] : '';
        check(name, Boolean(value && value.length >= minimum && !/\s/.test(value)), 'Existing token aliases must be present and match; values are redacted.');
        return value;
    }
    const listener = token('listener token', ['NEWSCRAFT_AGENT_API_TOKEN', 'NEWSCRAFT_HERMES_API_TOKEN', 'NEWSCRAFT_AGENT_SESSION_TOKEN', 'HERMES_AGUI_SESSION_TOKEN'], 24);
    const callback = token('callback token', ['NEWSCRAFT_AGENT_RUN_API_TOKEN', 'NEWSCRAFT_HERMES_RUN_API_TOKEN'], 1);
    const tenant = token('tenant token', ['NEWSCRAFT_AGENT_TENANT_SECRET', 'NEWSCRAFT_HERMES_TENANT_SECRET'], 32);
    const session = token('app session secret', ['APP_SESSION_SECRET'], 1);
    check('session shape', /^[A-Za-z0-9+/]+={0,2}$/.test(session) && Buffer.from(session, 'base64').length >= 32, 'Session signing secret must decode to at least 32 bytes.');
    let credentialReady = false;
    const credentialName = selectedProvider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY';
    try {
        credentialReady = selectedCredentialReady(resolve(root, CREDENTIAL), credentialName);
    } catch { /* Report no paths, file contents or original exception. */ }
    check('approved credential', credentialReady, `Approved ${credentialName} reference must have one usable key shape; no key is copied or printed.`);
    check('dependency files', dependencyFilesReady(root), 'Owned interpreter and required package files must exist; import execution is not performed.');
    const environment = { ...inherited, ...config, DATABASE_URL: supplied,
        NEWSCRAFT_TEST_DATABASE_URL: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', DEEPSEEK_API_KEY: '', NEWSCRAFT_SETUP_DATABASE_URL: '',
        NEWSCRAFT_AGENT_API_TOKEN: listener, NEWSCRAFT_HERMES_API_TOKEN: listener,
        NEWSCRAFT_AGENT_SESSION_TOKEN: listener, HERMES_AGUI_SESSION_TOKEN: listener,
        NEWSCRAFT_AGENT_RUN_API_TOKEN: callback, NEWSCRAFT_HERMES_RUN_API_TOKEN: callback,
        NEWSCRAFT_AGENT_TENANT_SECRET: tenant, NEWSCRAFT_HERMES_TENANT_SECRET: tenant, APP_SESSION_SECRET: session };
    return result(environment);
}

export function checkLocal(options) { return resolveLocalSetup(options).report; }

export function parseLocalArguments(args) {
    if (args.length === 1) return { command: args[0], provider: undefined };
    if (args.length === 3 && args[1] === '--provider') return { command: args[0], provider: args[2] };
    return { command: '', provider: undefined };
}

export async function runLocal(command, { root = ROOT, env = process.env, nodeVersion = process.versions.node, provider, spawn = spawnProcess, write = line => console.log(line) } = {}) {
    if (command === 'prepare') {
        if (provider !== undefined) { write('Provider selection is supported only for check or start.'); return 2; }
        const status = prepareLocal({ root }); write(status.message); return status.ok ? 0 : 1;
    }
    if (!['check', 'start'].includes(command)) { write('Usage: node scripts/agent-local.mjs prepare|check|start [--provider openai|deepseek]'); return 2; }
    const { report, environment } = resolveLocalSetup({ root, env, nodeVersion, provider });
    for (const item of report.checks) write(`${item.ok ? 'OK' : 'BLOCKED'}: ${item.name}. ${item.detail}`);
    for (const limitation of report.limitations) write(`NOTE: ${limitation}`);
    if (!report.ok || command === 'check') return report.ok ? 0 : 1;
    try {
        const child = spawn(process.execPath, [resolve(root, 'scripts/dev-all.mjs')], { cwd: root, env: environment, stdio: 'inherit' });
        const stop = signal => { try { child.kill(signal); } catch { /* No exception values in output. */ } };
        const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
        process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
        try { const [code] = await once(child, 'exit'); return Number.isInteger(code) ? code : 1; }
        finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
    } catch { write('Local start failed; no exception or environment values were printed.'); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { command, provider } = parseLocalArguments(process.argv.slice(2));
    process.exitCode = await runLocal(command, { provider });
}
