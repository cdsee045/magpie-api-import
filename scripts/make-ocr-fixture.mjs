import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
try{
  const page=await browser.newPage({viewport:{width:1200,height:420}});
  await page.setContent('<canvas width="1200" height="420"></canvas>');
  const png=await page.evaluate(()=>{const c=document.querySelector('canvas'),ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle='#111';ctx.font='30px Consolas, monospace';['name: Screenshot API','url: https://api.example.test/v1','key: fixture_test_ABCD1234567890','model: fixture-model'].forEach((line,i)=>ctx.fillText(line,35,65+i*80));return c.toDataURL('image/png').split(',')[1];});
  await mkdir('tests/fixtures',{recursive:true});await writeFile('tests/fixtures/api-screenshot.png',Buffer.from(png,'base64'));console.log('Wrote synthetic OCR fixture (no real credentials).');
}finally{await browser.close();}
