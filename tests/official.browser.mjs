import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { _internal } from '../dist/plugin.mjs';
import { keys as sharedKeys } from './fixtures/shared-api.mjs';
import {keys as forumKeys,urls as forumUrls,models as forumModels} from './fixtures/forum-api.mjs';

const fixture = { name: '我的测试 API', key: 'fixture_browser_key_123456789', model: 'fixture-model' };
let calls = 0, delay = 0, failureStatus = 0, stallBody = false, paths = [], authorizations = [];
const api = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  paths.push(req.url);
  authorizations.push(req.headers.authorization);
  if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return; }
  if (req.url.endsWith('/models')) { res.statusCode = 404; res.end('Not found'); return; }
  calls++; if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  res.setHeader('Content-Type', 'application/json');
  if (failureStatus) { res.statusCode = failureStatus; res.end('{}'); return; }
  if (stallBody) { res.write('{"choices":'); const timer = setTimeout(() => res.end('[]}'), 13_000); res.on('close', () => clearTimeout(timer)); return; }
  if (req.headers.authorization?.includes('invalid')) { res.statusCode = 401; res.end(JSON.stringify({ error: { message: fixture.key } })); return; }
  assert.equal(JSON.parse(body).model, fixture.model);
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
});
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
fixture.url = `http://127.0.0.1:${api.address().port}/v1`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const errors = [], flows = [];
let checks = 0;
await mkdir('artifacts/official-ui', { recursive: true });
async function fresh(width = 1100, colorScheme = 'light', options = {}) {
  const flow = await _internal.startBrowserFlow(options); flows.push(flow);
  const context = await browser.newContext({ viewport: { width, height: 1100 }, colorScheme });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(flow.url); return { flow, page, context };
}
async function paste(page, data) { await page.locator('#input-text').fill(typeof data === 'string' ? data : JSON.stringify(data)); await page.locator('#parse-input').click(); }
try {
  {
    let upstream=0;
    const {page,context}=await fresh(1100,'light',{validator:{async models(){upstream++;throw Error('unexpected request');},async validate(){upstream++;throw Error('unexpected request');}}});
    await page.locator('#image-file').setInputFiles('tests/fixtures/forum-light.png');await page.locator('#parse-input').click();
    await expect(page.locator('#choices button')).toHaveCount(3,{timeout:60000});
    for(let index=0;index<3;index++){
      await page.locator('#choices button').nth(index).click();
      await expect(page.locator('#name')).toHaveValue(`Key ${index+1}`);await expect(page.locator('#url')).toHaveValue(forumUrls[0]);
      await expect(page.locator('#model')).toHaveValue(forumModels[index][0]);
      assert.deepEqual(await page.locator('#model-picker option').evaluateAll(items=>items.map(x=>x.value).filter(Boolean)),forumModels[index]);
      assert.equal(await page.evaluate(()=>globalThis.apiImport.revealKey()),forumKeys[index]);
      await expect(page.locator('#masked-key')).not.toContainText('未提供');
      const state=await page.evaluate(()=>fetch(new URL('state',location.href),{headers:{'X-API-Import':'1'}}).then(r=>r.json()));
      assert.ok(state.candidates.every(c=>!('key'in c)&&!('encodedKey'in c)&&!('encodedKeyOriginal'in c)));
      assert.ok(!JSON.stringify(state).includes(forumKeys[index]));
      await page.locator('#validate').click();await expect(page.locator('#validation-status')).toContainText('需要核对');
      assert.equal(upstream,0);checks+=3;
    }
    await page.screenshot({path:'artifacts/official-ui/automatic-forum-fields.png',fullPage:true});await context.close();
  }
  // Exercise the viewport where users actually press Validate, including
  // terminal failures, missing fields, stalled responses and a safe retry.
  for (const status of [401, 404, 429, 500]) {
    const { page, context } = await fresh(); await page.setViewportSize({width:1100,height:650});
    await paste(page, {...fixture, model:''}); await expect(page.locator('#notice')).toContainText('已获取 1 个模型');
    await page.locator('#model-picker').selectOption(fixture.model); failureStatus=status;
    await page.locator('#validate').click();
    await expect(page.locator('#validation-status')).toContainText(status === 401 ? 'Key 无效' : status === 404 ? '接口路径或模型不存在' : status === 429 ? '限流或额度不足' : 'HTTP 500');
    await expect(page.locator('#validation-status')).toBeInViewport();
    await expect(page.locator('#validate')).toBeEnabled(); await expect(page.locator('#validate')).toHaveText('验证 API');
    assert.equal(await page.locator('#confirmation').isVisible(),false); checks+=3;
    if(status===404) await page.screenshot({path:'artifacts/official-ui/validation-error.png'});
    failureStatus=0; await context.close();
  }
  {
    const { page, context } = await fresh(); await page.setViewportSize({width:375,height:650});
    await paste(page,{...fixture,model:''}); await expect(page.locator('#notice')).toContainText('已获取 1 个模型');
    const before=calls;
    await page.locator('#validate').click(); await expect(page.locator('#validation-status')).toContainText('请选择或填写要验证的模型');
    await expect(page.locator('#validation-status')).toBeInViewport(); assert.equal(calls,before); checks+=2;
    await page.locator('#url').fill(''); await page.locator('#validate').click();
    await expect(page.locator('#validation-status')).toContainText('请填写完整的 API 地址'); assert.equal(calls,before); checks++;
    await context.close();
  }
  {
    const { page, context } = await fresh();
    await paste(page,{...fixture,model:''}); await expect(page.locator('#notice')).toContainText('已获取 1 个模型');
    await page.locator('#model-picker').selectOption(fixture.model); const before=calls; delay=900;
    await page.locator('#validate').click(); await expect(page.locator('#validate')).toHaveText('验证中…');
    await expect(page.locator('#validation-status')).toContainText('最多等待 12 秒');
    await expect(page.locator('#validate')).toBeDisabled();
    await page.evaluate(()=>{document.querySelector('#validate').click();document.querySelector('#validate').click();});
    await page.locator('#confirmation').waitFor({state:'visible'}); assert.equal(calls,before+1); checks+=2;
    delay=0; await context.close();
  }
  {
    const { page, context } = await fresh(); await page.setViewportSize({width:1100,height:650});
    await paste(page,{...fixture,model:''}); await expect(page.locator('#notice')).toContainText('已获取 1 个模型');
    await page.locator('#model-picker').selectOption(fixture.model); const before=calls; stallBody=true;
    const started=Date.now(); await page.locator('#validate').click();
    await expect(page.locator('#validation-status')).toContainText('连接超时',{timeout:16000});
    assert.ok(Date.now()-started<16000); assert.equal(calls,before+1);
    await expect(page.locator('#validation-status')).toBeInViewport(); await expect(page.locator('#validate')).toBeEnabled(); checks+=3;
    stallBody=false; await page.locator('#validate').click(); await page.locator('#confirmation').waitFor({state:'visible'});
    assert.equal(calls,before+2); checks++; await context.close();
  }
  {
    const { page, context } = await fresh();
    await paste(page,{...fixture,model:''}); await expect(page.locator('#notice')).toContainText('已获取 1 个模型');
    await page.locator('#model-picker').selectOption(fixture.model);
    await page.route('**/command',route=>route.request().postDataJSON().type==='verify'?route.abort():route.continue());
    await page.locator('#validate').click(); await expect(page.locator('#validation-status')).toContainText('导入连接未响应或已关闭');
    await expect(page.locator('#validate')).toBeEnabled(); checks++; await context.close();
  }
  {
    const { flow, page, context } = await fresh();
    const before=calls;
    await paste(page, fixture); await page.locator('#confirmation').waitFor({ state: 'visible' });
    assert.equal(calls,before+1); checks++;
    assert.ok(!(await page.locator('#summary').innerText()).includes(fixture.key)); checks++;
    await expect(page.locator('#input-text')).toHaveValue('');
    await page.locator('#confirm').click(); await expect(page.locator('#notice')).toContainText('提交给 Magpie');
    const result = await flow.result; assert.equal(result.type, 'success'); assert.equal(result.key, fixture.key); checks += 2;
    await page.screenshot({ path: 'artifacts/official-ui/submitted.png', fullPage: true }); await context.close();
  }
  {
    const { page, context } = await fresh();
    await paste(page, { ...fixture, key: 'fixture_invalid_key_123456789' });
    await expect(page.locator('#notice')).toContainText('Key 无效');
    assert.equal(await page.locator('#confirmation').isVisible(), false); checks++;
    await page.locator('#key').fill(fixture.key); await page.locator('#validate').click();
    await page.locator('#confirmation').waitFor({ state: 'visible' }); await page.keyboard.press('Escape');
    await expect(page.locator('#confirmation')).not.toBeVisible(); checks++;
    await context.close();
  }
  {
    const { page, context } = await fresh(); const before = calls, pathCount = paths.length;
    await paste(page, { _type: 'newapi_channel_conn', url: new URL(fixture.url).origin, key: fixture.key });
    await expect(page.locator('#notice')).toContainText('已获取 1 个模型');
    await expect(page.locator('#url')).toHaveValue(fixture.url); await expect(page.locator('#model')).toHaveValue('');
    await expect(page.locator('#model-picker')).toBeVisible();
    assert.equal(calls, before); assert.deepEqual(paths.slice(pathCount), ['/v1/models']); checks += 2;
    await page.locator('#model-picker').selectOption(fixture.model); await page.locator('#validate').click();
    await page.locator('#confirmation').waitFor({ state: 'visible' }); assert.equal(calls, before + 1); checks++;
    await page.screenshot({ path: 'artifacts/official-ui/newapi.png', fullPage: true });
    await context.close();
  }
  {
    const { page, context } = await fresh();
    await paste(page, [{ ...fixture }, { ...fixture, name: '第二条', key: 'fixture_second_key_123456789' }]);
    await expect(page.locator('#choices button')).toHaveCount(2);
    await page.locator('#choices button').nth(1).click();
    await expect(page.locator('#summary')).toContainText('第二条'); checks++;
    await context.close();
  }
  {
    const { flow, page, context } = await fresh(); const before = calls, pathCount = paths.length;
    const keys = ['sk-fixture_group_first_123456789', 'sk-fixture_group_second_123456789', 'sk-fixture_group_third_123456789'];
    await paste(page, `baseurl: ${fixture.url}\n第一组\nKey(base64): ${Buffer.from(keys[0]).toString('base64')}\n第二组\nKey(base64):\n\n${Buffer.from(keys[1]).toString('base64')}\n第三组\nKey(base64):\n${Buffer.from(keys[2]).toString('base64')}`);
    await expect(page.locator('#choices button')).toHaveCount(3);
    assert.equal(calls, before); assert.equal(paths.length, pathCount); checks++;
    const labels = await page.locator('#choices').innerText();
    assert.ok(keys.every(key => !labels.includes(key) && !labels.includes(Buffer.from(key).toString('base64')))); checks++;
    await page.locator('#choices button').nth(1).click();
    await expect(page.locator('#notice')).toContainText('已获取 1 个模型');
    await expect(page.locator('#url')).toHaveValue(fixture.url);
    assert.deepEqual(paths.slice(pathCount), ['/v1/models']);
    assert.deepEqual(authorizations.slice(pathCount), ['Bearer ' + keys[1]]); checks++;
    await page.locator('#model-picker').selectOption(fixture.model); await page.locator('#validate').click();
    await page.locator('#confirmation').waitFor({ state: 'visible' });
    await expect(page.locator('#summary')).toContainText('第二组');
    await page.locator('#confirm').click(); const result = await flow.result;
    assert.equal(result.type, 'success'); assert.equal(result.key, keys[1]);
    assert.equal(calls, before + 1); assert.deepEqual(authorizations.slice(pathCount), ['Bearer ' + keys[1], 'Bearer ' + keys[1]]); checks += 2;
    await context.close();
  }
  {
    const { page, context } = await fresh();
    await paste(page, fixture); await page.locator('#confirmation').waitFor({ state: 'visible' });
    const cleared = await page.evaluate(() => {
      const key = document.getElementById('key'); key.value = 'fixture-visible-key'; key.type = 'text';
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      return { key: key.value, dialog: document.getElementById('confirmation').open };
    });
    assert.deepEqual(cleared, { key: '', dialog: false }); checks++;
    await context.close();
  }
  {
    const { flow, page, context } = await fresh(); const before = calls, pathCount = paths.length;
    const key = 'sk-fixture_unlabelled_123456789', encoded = Buffer.from(key).toString('base64');
    await paste(page, `url:${fixture.url}/ ${encoded}`);
    await expect(page.locator('#review-wrap')).toBeVisible();
    await expect(page.locator('#url')).toHaveValue(fixture.url);
    await page.locator('#load-models').click(); await expect(page.locator('#notice')).toContainText('需要核对');
    assert.equal(calls, before); assert.equal(paths.length, pathCount); checks++;
    await page.locator('#reveal').click(); await expect(page.locator('#key')).toHaveValue(key);
    await page.locator('#review').check(); await page.locator('#load-models').click();
    await expect(page.locator('#notice')).toContainText('已获取 1 个模型');
    assert.deepEqual(paths.slice(pathCount), ['/v1/models']);
    assert.deepEqual(authorizations.slice(pathCount), ['Bearer ' + key]); checks++;
    await page.locator('#model-picker').selectOption(fixture.model); await page.locator('#validate').click();
    await page.locator('#confirmation').waitFor({ state: 'visible' });
    await page.locator('#confirm').click(); const result = await flow.result;
    assert.equal(result.type, 'success'); assert.equal(result.key, key);
    assert.equal(calls, before + 1); assert.deepEqual(paths.slice(pathCount), ['/v1/models', '/v1/chat/completions']); checks += 2;
    await context.close();
  }
  {
    const { flow, page, context } = await fresh(); delay = 400;
    await paste(page, fixture); await expect(page.locator('#notice')).toContainText('正在进行最小真实调用');
    await page.close(); const result = await flow.result; assert.equal(result.type, 'failed'); checks++; delay = 0;
    await context.close();
  }
  {
    const { page, context } = await fresh();
    await paste(page, `url:${fixture.url} ${Buffer.from('sk-fixture_late_encoded_123456789').toString('base64')}`);
    await expect(page.locator('#review-wrap')).toBeVisible();
    await page.route('**/encoded-key', async route => {
      const response = await route.fetch();
      await page.evaluate(() => { Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange')); });
      await route.fulfill({response});
    });
    const response = page.waitForResponse(r => r.url().endsWith('/encoded-key'));
    await page.locator('#encoded-reveal').click(); await response;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#encoded-key')).toHaveValue(''); await expect(page.locator('#encoded-editor')).toBeHidden(); checks++;
    await context.close();
  }
  {
    const { page, context } = await fresh();
    await page.locator('#image-file').setInputFiles('tests/fixtures/api-screenshot.png');
    await page.locator('#parse-input').click();
    await page.locator('#review-wrap').waitFor({ state: 'visible', timeout: 60000 });
    assert.equal(await page.locator('#confirmation').isVisible(), false); checks++;
    await page.locator('#reveal').click(); await expect(page.locator('#key')).toHaveAttribute('type', 'text');
    assert.ok((await page.locator('#key').inputValue()).length > 10); checks++;
    await page.locator('#key').fill(fixture.key); await page.locator('#url').fill(fixture.url);
    await page.locator('#model').fill(fixture.model); await page.locator('#review').check(); await page.locator('#validate').click();
    await page.locator('#confirmation').waitFor({ state: 'visible' }); checks++;
    await context.close();
  }
  {
    const { flow, page, context } = await fresh(375); const before=calls, pathCount=paths.length;
    await page.locator('#image-file').setInputFiles('tests/fixtures/shared-api-screenshot.png'); await page.locator('#parse-input').click();
    await expect(page.locator('#choices button')).toHaveCount(3,{timeout:60000});
    assert.equal(paths.length,pathCount); assert.equal(calls,before); checks++;
    await page.locator('#choices button').nth(0).click();
    await expect(page.locator('#choices button').nth(1)).toBeEnabled();
    await page.locator('#validate').click(); await expect(page.locator('#choices button').nth(1)).toBeEnabled(); checks++;
    await page.locator('#choices button').nth(1).click(); await expect(page.locator('#url-picker')).toBeVisible();
    await expect(page.locator('#url')).toHaveValue('https://api.example.test');
    await page.locator('#url-picker').selectOption('https://cdn.example.test');
    await expect(page.locator('#url')).toHaveValue('https://cdn.example.test');
    assert.equal(paths.length,pathCount); checks++;
    await expect(page.locator('#encoded-key')).toHaveValue('');
    await page.locator('#encoded-reveal').click(); await expect(page.locator('#encoded-editor')).toBeVisible();
    assert.ok((await page.locator('#encoded-key').inputValue()).length>70); checks++;
    await page.locator('#encoded-key').fill('%%%'); await page.locator('#decode-key').click(); await expect(page.locator('#notice')).toContainText('Base64 解码失败');
    await page.locator('#encoded-key').fill(Buffer.from(sharedKeys[1]).toString('base64')); await page.locator('#decode-key').click();
    await expect(page.locator('#notice')).toContainText('本机重新解码');
    assert.equal(paths.length,pathCount); checks++;
    const width=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth})); assert.ok(width.scroll<=width.viewport+1); checks++;
    await page.screenshot({path:'artifacts/official-ui/multi-key.png',fullPage:true});
    await page.locator('#url').fill(fixture.url); await page.locator('#model').fill(fixture.model); await page.locator('#review').check(); await page.locator('#validate').click();
    await page.locator('#confirmation').waitFor({state:'visible'}); await expect(page.locator('#encoded-key')).toHaveValue('');
    await page.locator('#confirm').click(); const result=await flow.result;
    assert.equal(result.type,'success'); assert.equal(result.key,sharedKeys[1]); assert.equal(calls,before+1);
    assert.deepEqual(authorizations.slice(pathCount),['Bearer '+sharedKeys[1]]); checks+=2;
    await context.close();
  }
  for (const width of [320, 375, 736, 1100]) for (const colorScheme of ['light', 'dark']) {
    const { page, context } = await fresh(width, colorScheme);
    await paste(page, fixture); await page.locator('#confirmation').waitFor({ state: 'visible' });
    const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(size.scroll <= size.width + 1, JSON.stringify(size)); checks++;
    if (width === 375 || width === 1100) await page.screenshot({ path: `artifacts/official-ui/${colorScheme}-${width}.png`, fullPage: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', checks, browserErrors: errors.length, screenshots: 'artifacts/official-ui' }, null, 2));
} finally { await browser.close(); for (const flow of flows) await flow.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
