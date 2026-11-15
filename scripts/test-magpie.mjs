import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Uses the installed, unmodified Magpie binary and the Bun host it extracts.
// All config, auth, cache and synthetic API traffic stays in a fresh sandbox.
const root = fileURLToPath(new URL('..', import.meta.url));
const magpie = process.env.MAGPIE_EXECUTABLE || (process.platform === 'win32' ? path.join(homedir(), 'AppData/Local/Programs/magpie/magpie.com') : 'magpie');
const bun = process.env.BUN_EXECUTABLE || path.join(root, 'node_modules/bun/bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
await mkdir(path.join(root, '.sandbox'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.sandbox/magpie-official-'));
const env = { ...process.env, XDG_CONFIG_HOME: path.join(directory, 'config'), XDG_CACHE_HOME: path.join(directory, 'cache'), MAGPIE_BUN: bun, MAGPIE_NO_ACCOUNTS: '1' };
async function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(magpie, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    const timeout = setTimeout(() => child.kill(), 60_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve(stdout) : reject(new Error(`Magpie ${args[0]} exited ${code}; diagnostic bytes: ${stderr.length}`)); });
  });
}
const version = (await cli(['--version'])).trim();
const locations = await cli(['data']);
assert.ok(locations.includes(path.join(directory, 'config')) && locations.includes(path.join(directory, 'cache')), 'Magpie must honor isolated data paths');
await cli(['plugin', 'add', root]);
const installed = JSON.parse(await cli(['plugin', 'list', '--json']));
assert.ok(installed.providers.some(p => p.id === 'api-import' && p.methods[0]?.type === 'oauth'));
assert.equal(installed.loaded.find(p => p.spec === root)?.error, undefined);
const hostDir = path.join(directory, 'cache/magpie/plugin-host');
const hostName = (await readdir(hostDir)).find(name => /^host-.*\.js$/.test(name));
assert.ok(hostName, 'official binary must have extracted its own host');
const authPath = path.join(directory, 'config/magpie/plugin-auth.json');
const unrelated = { type: 'api', key: 'fixture_existing_unrelated_key_123456789' };
await writeFile(authPath, JSON.stringify({ unrelated }));
let calls = 0, modelLists = 0;
const api = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.method === 'GET' && req.url === '/v1/models') {
    modelLists++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return;
  }
  const body = JSON.parse(raw); assert.equal(body.model, 'fixture-model');
  assert.equal(req.headers.authorization, 'Bearer fixture_official_key_123456789'); calls++;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
});
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${api.address().port}/v1`;
const candidate = { name: 'Official fixture', url: baseURL, key: 'fixture_official_key_123456789', model: 'fixture-model', models: ['fixture-model', 'unverified-model'] };
const host = spawn(bun, ['run', path.join(hostDir, hostName)], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let next = 0, stderr = '', logMessages = [], pending = new Map();
host.stderr.on('data', data => stderr += data);
const lines = createInterface({ input: host.stdout });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.event === 'log') logMessages.push(message);
  const item = pending.get(message.id); if (!item) return;
  if (message.event) { item.events.push(message); return; }
  pending.delete(message.id); clearTimeout(item.timeout);
  if (message.error) item.reject(new Error('Official host rejected ' + item.method + ': ' + message.error.message));
  else item.resolve({ result: message.result, events: item.events });
});
function rpc(method, params = {}) {
  const id = ++next;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Official host timed out: ' + method)); }, 65_000);
    pending.set(id, { resolve, reject, events: [], timeout, method });
    host.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
async function ask(method, params) { return (await rpc(method, params)).result; }
async function call(url, part, body) {
  const response = await fetch(new URL(part, url), { method: 'POST', headers: { Origin: new URL(url).origin, 'X-API-Import': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200); return response.json();
}
async function importOne(connectionOnly = false) {
  const login = await ask('authorize', { provider: 'api-import', method: 0 });
  assert.equal(login.ok, true); assert.ok(login.url.startsWith('http://127.0.0.1:'));
  const completed = ask('callback', { session: login.session });
  const input = connectionOnly ? { _type: 'newapi_channel_conn', url: new URL(baseURL).origin, key: candidate.key } : candidate;
  await call(login.url, 'input', { kind: 'text', text: JSON.stringify(input) });
  await call(login.url, 'command', { type: 'detect' });
  if (connectionOnly) {
    const response = await fetch(new URL('state', login.url), { headers: { 'X-API-Import': '1' } });
    const waiting = await response.json(); assert.equal(waiting.status, 'incomplete');
    assert.equal(waiting.candidates[0].url, baseURL); assert.equal(waiting.candidates[0].model, '');
    assert.deepEqual(waiting.candidates[0].models, ['fixture-model']); assert.equal(calls, 0);
    await call(login.url, 'command', { type: 'edit', changes: { model: candidate.model } });
    await call(login.url, 'command', { type: 'verify' });
  }
  const r = await fetch(new URL('state', login.url), { headers: { 'X-API-Import': '1' } });
  const checked = await r.json(); assert.equal(checked.status, 'verified'); assert.ok(!JSON.stringify(checked).includes(candidate.key));
  await call(login.url, 'command', { type: 'confirm' });
  const answer = await completed; assert.equal(answer.ok, true); return answer;
}
try {
  const init = await ask('init', { plugins: [{ spec: root, target: root }], authPath, directory: path.dirname(authPath), loadMillis: 10000 });
  assert.equal(init.plugins[0]?.error, undefined);
  const first = await importOne(true); assert.equal(modelLists, 1);
  let stored = JSON.parse(await readFile(authPath, 'utf8'));
  assert.deepEqual(stored.unrelated, unrelated);
  const imported = Object.values(stored).filter(auth => auth.metadata?.version === 1);
  assert.equal(imported.length, 1); assert.equal(imported[0].key, candidate.key); assert.equal(imported[0].metadata.model, candidate.model);
  let providers = await ask('providers');
  const provider = providers.find(p => p.id === 'api-import');
  assert.equal(provider.accounts.length, 1); assert.equal(provider.models.length, 1);
  assert.equal(provider.models[0].apiId, candidate.model);
  const model = provider.models[0];
  const sent = await rpc('fetch', { provider: 'api-import', account: first.account, model: model.id, npm: '@ai-sdk/openai-compatible', url: baseURL + '/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: model.apiId, messages: [{ role: 'user', content: 'fixture' }], stream: false })).toString('base64'), window: 512 * 1024 });
  assert.equal(sent.events.find(e => e.event === 'head')?.status, 200);
  assert.ok(Buffer.concat(sent.events.filter(e => e.event === 'chunk').map(e => Buffer.from(e.data, 'base64'))).toString().includes('OK'));
  await importOne(); // stable metadata.email lets Magpie replace the same account
  providers = await ask('providers'); assert.equal(providers.find(p => p.id === 'api-import').accounts.length, 1);
  const cancelled = await ask('authorize', { provider: 'api-import', method: 0 });
  const cancelledResult = ask('callback', { session: cancelled.session });
  await call(cancelled.url, 'cancel', {}); assert.equal((await cancelledResult).ok, false);
  stored = JSON.parse(await readFile(authPath, 'utf8'));
  assert.equal(Object.keys(stored).length, 2); assert.deepEqual(stored.unrelated, unrelated);
  assert.ok(!JSON.stringify(logMessages).includes(candidate.key) && !stderr.includes(candidate.key));
  host.stdin.end();
  await new Promise(resolve => host.once('close', resolve));
  const reloaded = JSON.parse(await cli(['plugin', 'list', '--json']));
  const actual = reloaded.providers.find(p => p.id === 'api-import'); assert.equal(actual.accounts.length, 1); assert.equal(actual.models[0].apiId, candidate.model);
  console.log(JSON.stringify({ result: 'PASS', version, officialHost: hostName, pluginLoaded: true, newApiRootAndModelSelectionPassed: true, officialAccountSaved: true, accountReloaded: true, gatewayFetchHookPassed: true, duplicateAccountPrevented: true, cancelledLoginNotSaved: true, unrelatedAccountPreserved: true, fixtureRequests: calls, realCredentialsUsed: false, sandbox: directory }, null, 2));
} finally {
  host.kill(); lines.close(); for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new Error('test shutdown')); }
  api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
}
