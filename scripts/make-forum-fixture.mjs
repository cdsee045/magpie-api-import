import{chromium}from'@playwright/test';
import{writeFile}from'node:fs/promises';
import{urls,keys,models}from'../tests/fixtures/forum-api.mjs';
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
try{
 const page=await browser.newPage();
 for(const dark of [false,true]){
  const png=await page.evaluate(({dark,urls,encoded,models})=>{
   const c=document.createElement('canvas');c.width=906;c.height=457;const ctx=c.getContext('2d');
   ctx.fillStyle=dark?'#151515':'#fff';ctx.fillRect(0,0,c.width,c.height);ctx.font='17px Arial';ctx.textBaseline='top';
   const ink=dark?'#eee':'#333';
   ctx.fillStyle=ink;ctx.beginPath();ctx.arc(2,7,14,0,Math.PI*2);ctx.fill();
   for(let i=0;i<2;i++){
    const y=28+i*25,label=i?'url（CDN加速）：':'url: ';ctx.fillStyle=ink;ctx.fillText(label,28,y);
    const x=28+ctx.measureText(label).width;ctx.fillStyle=dark?'#4ba5ff':'#0095e9';ctx.fillText('↗ '+urls[i]+'/',x,y);
    const counterX=x+ctx.measureText('↗ '+urls[i]+'/').width+6;ctx.fillStyle=dark?'#444':'#eee';ctx.fillRect(counterX,y,23,18);ctx.fillStyle=dark?'#bbb':'#888';ctx.font='13px Arial';ctx.fillText(i?'34':'54',counterX+3,y+2);ctx.font='17px Arial';
   }
   for(let i=0;i<3;i++){
    const y=94+i*112;ctx.fillStyle=ink;ctx.fillText(`key${i+1}(BASE64):`,28,y);
    let split=encoded[i].length;while(ctx.measureText(encoded[i].slice(0,split)).width>840)split--;
    ctx.fillText(encoded[i].slice(0,split),28,y+24);ctx.fillText(encoded[i].slice(split),28,y+48);
    ctx.fillText('可用模型: '+models[i].join(' | '),28,y+72);
   }
   return c.toDataURL('image/png').split(',')[1];
  },{dark,urls,encoded:keys.map(k=>Buffer.from(k).toString('base64')),models});
  await writeFile(`tests/fixtures/forum-${dark?'dark':'light'}.png`,Buffer.from(png,'base64'));
 }
 console.log('Generated realistic 17px forum screenshots with fictional keys only.');
}finally{await browser.close();}
