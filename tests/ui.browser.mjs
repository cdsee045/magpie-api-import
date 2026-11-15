import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createPreviewServer } from '../scripts/dev.mjs';
const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const server=await createPreviewServer();
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
const errors=[];let checks=0;
await mkdir('artifacts/ui',{recursive:true});
const call=async(path,body)=>{const r=await fetch(server.url+'/api/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+server.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,200);return r.json();};
async function fresh(width=1100,colorScheme='light'){
  await call('reset',{});
  const context=await browser.newContext({viewport:{width,height:1100},colorScheme});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(server.url);const frame=page.frameLocator('iframe');await frame.locator('#detect').waitFor({state:'attached'});return{context,page,frame};
}
const enter=page=>page.getByRole('button',{name:'自定义供应商',exact:true}).click();
const prompt=frame=>frame.locator('#confirmation');
async function noOverflow(page){const child=page.frames().find(f=>f.parentFrame());const result=await child.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(result.scroll<=result.width+1,JSON.stringify(result));checks++;}
try{
  {
    const{context,page,frame}=await fresh();await enter(page);await prompt(frame).waitFor({state:'visible'});
    const summary=await frame.locator('#summary').innerText();assert.ok(!summary.includes('fixture_import_key_123456789'));checks++;
    await page.screenshot({path:'artifacts/ui/verified.png',fullPage:true});await noOverflow(page);
    await frame.locator('#confirm').click();await frame.locator('#notice').filter({hasText:'供应商已添加'}).waitFor();
    const data=await call('state');assert.equal(data.providers.length,2);assert.equal(data.providers.filter(p=>p.default).length,1);assert.equal(data.providers.find(p=>p.default).id,'existing');assert.equal(data.providers[1].verifiedModel,'fixture-model');checks+=4;
    await context.close();
  }
  {
    const{context,page,frame}=await fresh();await enter(page);await prompt(frame).waitFor({state:'visible'});await frame.locator('#cancel').click();
    await page.getByRole('button',{name:'智能体',exact:true}).click();await enter(page);await frame.locator('#notice').filter({hasText:'已检测过'}).waitFor();assert.equal((await call('state')).requestCount,1);checks++;
    await frame.locator('#detect').click();await prompt(frame).waitFor({state:'visible'});await context.close();
  }
  {
    const{context,page,frame}=await fresh();await call('fixture',{scenario:'invalid'});await enter(page);await frame.locator('#notice').filter({hasText:'Key 无效'}).waitFor();assert.equal(await prompt(frame).isVisible(),false);checks++;
    await frame.locator('#key').fill('fixture_corrected_key_123456789');await frame.locator('#validate').click();await prompt(frame).waitFor({state:'visible'});checks++;await context.close();
  }
  {
    const{context,page,frame}=await fresh();await call('fixture',{scenario:'multiple'});await enter(page);await frame.locator('#choices button').nth(1).waitFor();assert.equal((await call('state')).requestCount,0);checks++;
    await frame.locator('#choices button').nth(1).click();await prompt(frame).waitFor({state:'visible'});assert.ok((await frame.locator('#summary').innerText()).includes('另一条 API'));checks++;
    await frame.locator('#confirm').click();await frame.locator('#notice').filter({hasText:'供应商已添加'}).waitFor();await context.close();
  }
  {
    const{context,page,frame}=await fresh();await call('fixture',{scenario:'incomplete'});await enter(page);await frame.locator('#notice').filter({hasText:'请选择或填写'}).waitFor();
    await frame.locator('#load-models').click();await frame.locator('#notice').filter({hasText:'请选择一个模型'}).waitFor();assert.equal((await call('state')).requestCount,0);checks++;
    await frame.locator('#model').fill('fixture-model');await frame.locator('#validate').click();await prompt(frame).waitFor({state:'visible'});await context.close();
  }
  {
    const{context,page,frame}=await fresh();await call('fixture',{scenario:'valid',delay:350});await enter(page);await frame.locator('#notice').filter({hasText:'正在进行最小真实调用'}).waitFor();
    await page.getByRole('button',{name:'智能体',exact:true}).click();await page.waitForTimeout(500);const data=await call('state');assert.equal(data.state.confirmation,null);assert.equal(data.providers.length,1);checks+=2;await context.close();
  }
  {
    const{context,page,frame}=await fresh();await enter(page);await prompt(frame).waitFor({state:'visible'});await page.keyboard.press('Escape');await prompt(frame).waitFor({state:'hidden'});assert.equal((await call('state')).providers.length,1);checks++;
    await frame.locator('#auto').uncheck();await page.getByRole('button',{name:'供应商',exact:true}).click();await enter(page);assert.equal((await call('state')).requestCount,1);checks++;
    await frame.locator('#detect').click();await prompt(frame).waitFor({state:'visible'});await context.close();
  }
  {
    const{context,page,frame}=await fresh();await call('fixture',{scenario:'duplicate'});await enter(page);await frame.locator('#notice').filter({hasText:'配置已存在'}).waitFor();assert.equal((await call('state')).requestCount,0);checks++;await context.close();
  }
  for(const width of [320,375,736,1100])for(const colorScheme of ['light','dark']){
    const{context,page,frame}=await fresh(width,colorScheme);await enter(page);await prompt(frame).waitFor({state:'visible'});await noOverflow(page);
    if(width===375||width===1100)await page.screenshot({path:`artifacts/ui/${colorScheme}-${width}.png`,fullPage:true});
    await context.close();
  }
  {
    const{context,page,frame}=await fresh();const fixture=await import('node:fs/promises').then(fs=>fs.readFile('tests/fixtures/api-screenshot.png'));
    await call('fixture',{scenario:'image',png:fixture.toString('base64')});await enter(page);await frame.locator('#review-wrap').waitFor({state:'visible',timeout:60000});assert.equal((await call('state')).requestCount,0);checks++;
    await frame.locator('#reveal').click();await expect(frame.locator('#key')).toHaveAttribute('type','text');const key=await frame.locator('#key').inputValue();assert.ok(key.length>10);checks++;
    await frame.locator('#key').fill('fixture_reviewed_key_123456789');await frame.locator('#url').fill(server.url+'/v1');await frame.locator('#review').check();await frame.locator('#validate').click();await prompt(frame).waitFor({state:'visible'});checks++;
    await context.close();
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'PASS',checks,browserErrors:errors.length,screenshots:'artifacts/ui'},null,2));
}finally{await browser.close();await server.close();}
