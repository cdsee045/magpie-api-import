import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const spec = 'github:cdsee045/magpie-api-import#main';
const bun = process.env.BUN_EXECUTABLE || path.join(root, 'node_modules', 'bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
await mkdir(path.join(root, '.sandbox'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.sandbox', 'github-install-'));
const cache = path.join(directory, '.bun-cache');
await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'magpie-github-install-smoke', private: true, type: 'module' }));

// Exercise the same GitHub shorthand used by Magpie without inherited access
// tokens, SSH agents or Git credential helpers. Proxy settings remain intact.
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CEILING_DIRECTORIES: directory, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', BUN_INSTALL_CACHE_DIR: cache };
for (const name of Object.keys(env)) if (/^(?:GH_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_TOKEN|GITHUB_ACCESS_TOKEN|BUN_GITHUB_TOKEN|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_CONFIG|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/i.test(name)) delete env[name];

async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(bun, args, { cwd: directory, env, stdio: 'inherit', windowsHide: true });
    const timeout = setTimeout(() => child.kill(), 300_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`GitHub installation check exited with status ${code}`)); });
  });
}
await run(['add', '--ignore-scripts', '--no-progress', '--cache-dir', cache, spec]);

const probe = `
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
const mod = await import('magpie-api-import');
assert.equal(typeof mod.default, 'function');
assert.equal(typeof mod._internal.createSession, 'function');
const hooks = await mod.default({});
assert.equal(hooks.auth.provider, 'api-import');
assert.equal(hooks.auth.methods[0].type, 'oauth');
assert.equal(typeof hooks.auth.methods[0].authorize, 'function');
const packagePath = path.resolve('node_modules/magpie-api-import');
const pkg = JSON.parse(await readFile(path.join(packagePath,'package.json'),'utf8'));
const require = createRequire(path.join(packagePath,'package.json'));
for (const panel of pkg.magpie.panels) assert.ok((await stat(path.join(packagePath,panel.file))).isFile());
assert.ok((await stat(path.join(packagePath,pkg.magpie.page.file))).isFile());
for (const file of ['official.html','local-bridge.js','import.js']) assert.ok((await stat(path.join(packagePath,'ui',file))).isFile());
assert.ok((await stat(path.join(packagePath,'src/ocr-worker.mjs'))).isFile());
for(const file of ['recognizer.onnx','runtime.mjs','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm','manifest.json'])assert.ok((await stat(path.join(packagePath,'vendor/ocr',file))).size>0);
const core = path.dirname(require.resolve('tesseract.js-core/package.json'));
assert.ok((await stat(path.join(core,'tesseract-core-simd-lstm.wasm'))).size > 0);
for (const language of ['eng','chi_sim']) {
  const data = path.join(path.dirname(require.resolve('@tesseract.js-data/'+language+'/package.json')),'4.0.0_best_int',language+'.traineddata.gz');
  assert.ok((await stat(data)).size > 0);
}
const image = await readFile(${JSON.stringify(path.join(root, 'tests', 'fixtures', 'api-screenshot.png'))});
const {LocalOcr}=await import(pathToFileURL(path.join(packagePath,'src/ocr.ts')).href);
assert.equal((await new LocalOcr().recognize(image,new AbortController().signal)).engine,'ppocr-v6');
let flow;
try {
  flow=await mod._internal.startBrowserFlow();
  const call=async(part,body)=>{
    const response=await fetch(new URL(part,flow.url),{method:body?'POST':'GET',headers:{Origin:new URL(flow.url).origin,'X-API-Import':'1',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal(response.status,200);return response.json();
  };
  await call('input',{kind:'image',png:image.toString('base64')});
  await call('command',{type:'detect'});
  assert.equal((await call('state')).status,'review');
  assert.equal((await call('key',{})).key,'fixture_test_ABCD1234567890');
  await call('cancel',{});assert.equal((await flow.result).type,'failed');
} finally {await flow?.close();}
console.log(JSON.stringify({result:'PASS',spec:${JSON.stringify(spec)},version:pkg.version,entryLoaded:true,panelFilesPresent:true,localOcrFilesPresent:true,installedPackageOcrPassed:true,githubAuthentication:false},null,2));
`;
assert.ok(probe.length < 10_000);
await writeFile(path.join(directory, 'probe.mjs'), probe);
await run(['run', 'probe.mjs']);
