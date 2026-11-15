import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { _internal } from '../dist/plugin.mjs';

const fixture = { name: '我的测试 API', key: 'fixture_browser_key_123456789', model: 'fixture-model' };
let calls = 0, delay = 0;
const api = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (req.url.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return; }
  calls++; if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  res.setHeader('Content-Type', 'application/json');
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
async function fresh(width = 1100, colorScheme = 'light') {
  const flow = await _internal.startBrowserFlow(); flows.push(flow);
  const context = await browser.newContext({ viewport: { width, height: 1100 }, colorScheme });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(flow.url); return { flow, page, context };
}
async function paste(page, data) { await page.locator('#input-text').fill(typeof data === 'string' ? data : JSON.stringify(data)); await page.locator('#parse-input').click(); }
try {
  {
    const { flow, page, context } = await fresh();
    assert.equal(calls, 0); checks++;
    await paste(page, fixture); await page.locator('#confirmation').waitFor({ state: 'visible' });
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
    const { page, context } = await fresh();
    await paste(page, [{ ...fixture }, { ...fixture, name: '第二条', key: 'fixture_second_key_123456789' }]);
    await expect(page.locator('#choices button')).toHaveCount(2);
    await page.locator('#choices button').nth(1).click();
    await expect(page.locator('#summary')).toContainText('第二条'); checks++;
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
    const { flow, page, context } = await fresh(); delay = 400;
    await paste(page, fixture); await expect(page.locator('#notice')).toContainText('正在进行最小真实调用');
    await page.close(); const result = await flow.result; assert.equal(result.type, 'failed'); checks++; delay = 0;
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
