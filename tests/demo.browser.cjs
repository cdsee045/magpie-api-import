const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require(path.join(process.env.DEMO_NODE_MODULES,'playwright'));
const preview=pathToFileURL(process.env.DEMO_PREVIEW_PATH).href;
const artifacts=process.env.DEMO_ARTIFACT_DIR;
fs.mkdirSync(artifacts,{recursive:true});

(async()=>{
  const browser=await chromium.launch({executablePath:process.env.DEMO_BROWSER_PATH,headless:true,args:['--no-sandbox']});
  const errors=[],requests=[];
  let checks=0,lastPage=null;
  async function fresh(width=1100,colorScheme='light'){
    const context=await browser.newContext({viewport:{width,height:1100},colorScheme});
    const page=await context.newPage();lastPage=page;
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push({url:r.url(),type:r.resourceType()});});
    await page.goto(preview);
    const frame=page.frameLocator('iframe');
    await frame.locator('#mp-main h1').waitFor();
    return {context,page,frame};
  }
  async function scenario(frame,value){await frame.locator('#mp-scenario').selectOption(value);}
  async function enter(frame){await frame.locator('[data-action="custom"]').first().click();}
  async function expectText(locator,text){await locator.filter({hasText:text}).first().waitFor();checks++;}
  async function noPrompt(frame){assert.equal(await frame.locator('[data-testid="confirmation"]').count(),0);checks++;}
  async function snapshot(page,name){await page.screenshot({path:path.join(artifacts,name+'.png'),fullPage:true});}
  async function noOverflow(page){
    const frame=page.frames().find(f=>f.parentFrame());
    const report=await frame.evaluate(()=>{
      const root=document.getElementById('magpie-import-demo');
      const rect=root.getBoundingClientRect();
      const elements=[...root.querySelectorAll('button,input,select,textarea,h1,h2,p')].filter(el=>el.getClientRects().length&&!el.closest('[hidden]'));
      return {width:innerWidth,scroll:document.documentElement.scrollWidth,outside:elements.filter(el=>{const r=el.getBoundingClientRect();return r.right>innerWidth+1||r.left<-1;}).map(el=>el.id||el.textContent.slice(0,40)),rootWidth:rect.width};
    });
    assert.ok(report.scroll<=report.width+1,JSON.stringify(report));assert.deepEqual(report.outside,[],JSON.stringify(report));checks++;
  }
  try{
    {
      const {context,page,frame}=await fresh();
      await snapshot(page,'suppliers');await noOverflow(page);await noPrompt(frame);
      await enter(frame);await frame.locator('[role="dialog"]').waitFor();
      await expectText(frame.locator('[role="dialog"]'),'发现可用的 API');
      assert.equal(await frame.locator('[role="dialog"]').innerText().then(t=>t.includes('demo_valid_json_2026')),false);checks++;
      await snapshot(page,'verified-dialog');await noOverflow(page);
      await page.keyboard.press('Escape');await noPrompt(frame);
      await frame.locator('[data-action="providers"]').click();await enter(frame);
      await expectText(frame.locator('#mp-detection'),'本次未添加');await noPrompt(frame);
      await frame.locator('[data-action="reread"]').click();await frame.locator('[role="dialog"]').waitFor();
      await frame.locator('[data-action="add"]').click();
      await expectText(frame.locator('#mp-main'),'已添加 我的 API');
      assert.equal(await frame.locator('.mp-provider').count(),3);checks++;
      await expectText(frame.locator('[data-provider="deepseek"]'),'当前使用');
      await snapshot(page,'added');await context.close();
    }
    {
      const {context,page,frame}=await fresh();
      await scenario(frame,'invalid');await noPrompt(frame);await enter(frame);
      await expectText(frame.locator('#mp-detection'),'密钥不可用');await noPrompt(frame);await snapshot(page,'invalid-key');
      await frame.locator('#mp-key').fill('demo_valid_corrected');
      await frame.locator('[data-action="validate"]').click();
      await frame.locator('[role="dialog"]').waitFor();await expectText(frame.locator('[role="dialog"]'),'发现可用的 API');
      await context.close();
    }
    {
      const {context,page,frame}=await fresh();
      await scenario(frame,'image');await frame.locator('#mp-view-source').click();
      await expectText(frame.locator('#mp-source-shot'),'BLG 2:1');
      await frame.locator('#mp-view-source').click();await enter(frame);
      await expectText(frame.locator('#mp-detection'),'识别到 3 条');await noPrompt(frame);await snapshot(page,'multiple-keys');
      await frame.locator('[data-candidate="1"]').click();await frame.locator('[role="dialog"]').waitFor();
      await expectText(frame.locator('[role="dialog"]'),'BLG 2:1');await frame.locator('[data-action="add"]').click();
      await expectText(frame.locator('.mp-provider.mp-new'),'BLG 2:1');await context.close();
    }
    {
      const {context,page,frame}=await fresh();
      await scenario(frame,'incomplete');await enter(frame);await expectText(frame.locator('#mp-detection'),'缺少 API 地址');await noPrompt(frame);
      await frame.locator('#mp-base').fill('https://fixed.example/v1');await frame.locator('[data-action="validate"]').click();
      await frame.locator('[role="dialog"]').waitFor();checks++;await context.close();
    }
    {
      const {context,page,frame}=await fresh();
      await scenario(frame,'timeout');await enter(frame);await expectText(frame.locator('#mp-detection'),'连接超时');await noPrompt(frame);await context.close();
    }
    {
      const {context,page,frame}=await fresh();
      await scenario(frame,'unrelated');await enter(frame);await frame.locator('#mp-name:enabled').waitFor();
      assert.equal((await frame.locator('#mp-detection').innerText()).trim(),'');checks++;await noPrompt(frame);await context.close();
    }
    {
      const {context,page,frame}=await fresh();
      await scenario(frame,'duplicate');await enter(frame);await expectText(frame.locator('#mp-detection'),'这条配置已经存在');await noPrompt(frame);await context.close();
    }
    {
      const {context,page,frame}=await fresh();
      await enter(frame);await expectText(frame.locator('#mp-detection'),'正在验证');
      await frame.locator('[data-page="agents"]').click();await page.waitForTimeout(2000);
      await expectText(frame.locator('#mp-main h1'),'智能体');await noPrompt(frame);
      await frame.locator('[data-page="settings"]').click();await frame.locator('#mp-settings-auto').uncheck();
      await frame.locator('[data-page="providers"]').click();await enter(frame);
      assert.equal((await frame.locator('#mp-detection').innerText()).trim(),'');checks++;
      await frame.locator('[data-action="reread"]').click();await frame.locator('[role="dialog"]').waitFor();checks++;await context.close();
    }
    for(const width of [1024,736,375,320]){
      const {context,page,frame}=await fresh(width);
      await noOverflow(page);await enter(frame);await frame.locator('[role="dialog"]').waitFor();await noOverflow(page);
      if(width===375)await snapshot(page,'mobile-dialog');
      await context.close();
    }
    {
      const {context,page,frame}=await fresh(1100,'dark');await enter(frame);await frame.locator('[role="dialog"]').waitFor();
      await snapshot(page,'dark-dialog');await noOverflow(page);await context.close();
    }
    {
      const {context,page,frame}=await fresh();
      const child=page.frames().find(f=>f.parentFrame());
      await child.evaluate(()=>dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:{modelContent:{page:'providers',scenario:'json'},privateContent:{auto:true,promptStyle:'inline'}}}}})));
      await enter(frame);await frame.locator('.mp-inline-area [data-testid="confirmation"]').waitFor();checks++;
      assert.equal(await frame.locator('[role="dialog"]').count(),0);checks++;
      await snapshot(page,'inline-confirm');await noOverflow(page);
      await frame.locator('[data-action="add"]').click();await expectText(frame.locator('#mp-main'),'已添加 我的 API');await context.close();
    }
    assert.deepEqual(errors,[],'No uncaught browser errors');checks++;
    const runtimeScripts=new Set(['https://unpkg.com/@floating-ui/dom@1.7.4/dist/floating-ui.dom.umd.min.js','https://unpkg.com/lucide@1.17.0/dist/umd/lucide.js']);
    const apiRequests=requests.filter(r=>r.type!=='script'||!runtimeScripts.has(r.url));
    assert.deepEqual(apiRequests,[],'Only preview runtime scripts may load; no API requests');checks++;
    console.log(JSON.stringify({result:'PASS',checks,browserErrors:errors.length,apiRequests:apiRequests.length,previewRuntimeResources:requests.length,artifacts},null,2));
  } catch(error) {
    console.error('Browser errors:',errors);
    if(lastPage&&!lastPage.isClosed())await lastPage.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true});
    throw error;
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
