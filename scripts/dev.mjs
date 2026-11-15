import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { createSession } from '../dist/host.mjs';

// Development harness. Clipboard and provider storage are explicit fixtures.
// Requests go over real HTTP to a local stand-in. No real Magpie files or
// system clipboard are accessed, and no external API is needed.
export async function createPreviewServer(port = 0) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const token = randomBytes(32).toString('hex');
  let page = 'providers', scenario = 'valid', auto = true, session, latest;
  let providers = [], pageListener = () => {}, requestCount = 0, validationDelay = 0, image;
  let origin = '';
  const initial = () => ({ name:'已有供应商',url:origin+'/v1',key:'fixture_existing_key_123456789',protocol:'chat-completions',model:'fixture-model',models:['fixture-model'],needsKeyReview:false });
  const standard = () => ({ ...initial(), name:'我的 API',key:'fixture_import_key_123456789',models:['fixture-model','other-model'] });
  const clip = () => {
    if (scenario === 'empty') return {kind:'text',text:'今天是个好日子'};
    if (scenario === 'image') return {kind:'image',png:image ?? new Uint8Array()};
    let data = standard();
    if (scenario === 'duplicate') data = initial();
    if (scenario === 'invalid') data.key = 'fixture_invalid_key_123456789';
    if (scenario === 'incomplete') { data.model='';data.models=[]; }
    if (scenario === 'multiple') data = [data,{...data,name:'另一条 API',key:'fixture_second_key_123456789'}];
    return {kind:'text',text:JSON.stringify(data)};
  };
  const native = {
    currentPage:()=>page,
    onPage(fn){pageListener=fn;return ()=>{pageListener=()=>{};};},
    async readClipboard(signal){signal.throwIfAborted();if(page!=='providers/custom/new')throw new Error('page');return clip();},
    async hasProvider(identity,signal){signal.throwIfAborted();return providers.some(p=>p.identity===identity);},
    async appendProvider(input,signal){
      signal.throwIfAborted();if(page!=='providers/custom/new')throw new Error('page');
      if(providers.some(p=>p.identity===input.identity))throw new Error('duplicate');
      const id='import-'+providers.length;
      // Synchronous commit after checking cancellation is atomic in this harness.
      providers.push({id,identity:input.identity,name:input.candidate.name,default:false,verifiedModel:input.verifiedModel});
      return {id};
    },
    options:{async get(){return {auto};},async set(o){auto=o.auto;}},
  };
  function reset(){session?.dispose();page='providers';scenario='valid';auto=true;requestCount=0;validationDelay=0;const c=initial();providers=[{id:'existing',name:'已有供应商',default:true,identity:createHash('sha256').update(JSON.stringify([c.url,c.key,c.protocol])).digest('hex')}];session=createSession(native);session.subscribe(state=>latest=state);}
  const send=(res,status,body,type='application/json')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','Cross-Origin-Resource-Policy':'same-origin','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(type==='application/json'?JSON.stringify(body):body);};
  async function json(req){let body='';for await(const chunk of req){body+=chunk;if(body.length>2_000_000)throw new Error('size');}return JSON.parse(body||'{}');}
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,origin);
      if(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==origin))return send(res,403,{error:'origin'});
      if(url.pathname==='/v1/chat/completions'){
        await json(req);requestCount++;
        if(validationDelay)await new Promise(resolve=>setTimeout(resolve,validationDelay));
        if(req.headers.authorization?.includes('invalid'))return send(res,401,{error:'invalid fixture key'});
        return send(res,200,{choices:[{message:{role:'assistant',content:'OK'}}],usage:{completion_tokens:1}});
      }
      if(url.pathname==='/v1/models')return send(res,200,{data:[{id:'fixture-model'},{id:'other-model'}]});
      if(url.pathname.startsWith('/api/')){
        if(req.headers.authorization!==`Bearer ${token}`)return send(res,403,{error:'auth'});
        if(url.pathname==='/api/state')return send(res,200,{state:latest,providers,requestCount,page});
        if(url.pathname==='/api/key')return send(res,200,{key:session.revealKey()});
        const data=await json(req);
        if(url.pathname==='/api/command'){await session.command(data);return send(res,200,{ok:true});}
        if(url.pathname==='/api/page'){page=data.page;pageListener(page);return send(res,200,{ok:true});}
        if(url.pathname==='/api/fixture'){scenario=data.scenario;validationDelay=data.delay??0;if(data.png)image=Buffer.from(data.png,'base64');return send(res,200,{ok:true});}
        if(url.pathname==='/api/reset'){reset();return send(res,200,{ok:true});}
      }
      if(url.pathname.endsWith('/_magpie/bridge.js'))return send(res,200,bridge(token),'application/javascript');
      if(url.pathname==='/')return send(res,200,shell(token),'text/html; charset=utf-8');
      const allowed=new Map([['/ui/import.html','text/html; charset=utf-8'],['/ui/style.css','text/css'],['/ui/import.js','application/javascript'],['/ui/compatibility.html','text/html; charset=utf-8'],['/ui/compatibility.js','application/javascript']]);
      if(allowed.has(url.pathname))return send(res,200,await readFile(path.join(root,url.pathname.slice(1))),allowed.get(url.pathname));
      send(res,404,{error:'not found'});
    }catch{send(res,400,{error:'request failed'});}
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;reset();
  return {url:origin,token,close:async()=>{session.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
function bridge(token){return `(()=>{const token=${JSON.stringify(token)};const call=async(path,body)=>{const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error('bridge');return r.json();};let timer;globalThis.magpie={ready:Promise.resolve(),apiImport:{version:1,command:c=>call('command',c),revealKey:async()=>(await call('key')).key,subscribe:fn=>{let last='';const poll=async()=>{try{const {state}=await call('state');const text=JSON.stringify(state);if(last!==text){last=text;fn(state);}}catch{};};poll();timer=setInterval(poll,40);return()=>clearInterval(timer);}}};addEventListener('pagehide',()=>clearInterval(timer));})();`;}
function shell(token){return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>API 导入本地集成预览</title><style>body{margin:0;font:14px 'Segoe UI',sans-serif;background:#f4f6f3;color:#25332b}.banner{padding:12px 20px;background:#edf3e7;border-bottom:1px solid #dce4d7;font-size:12px}nav{display:flex;gap:10px;padding:18px;flex-wrap:wrap}button,select{font:inherit;padding:8px 12px;border:1px solid #d9e1d8;border-radius:6px;background:white}iframe{width:100%;height:1000px;border:0}#outside{padding:30px}#providers{margin-top:20px}</style><div class="banner">开发集成环境：剪贴板和供应商存储为隔离样例，验证使用本地 HTTP 服务，不修改 Magpie。</div><nav><button data-page="providers">供应商</button><button data-page="providers/custom/new">自定义供应商</button><button data-page="agents">智能体</button><select id="scenario" aria-label="测试样例"><option value="valid">有效 JSON</option><option value="invalid">失效 Key</option><option value="multiple">多个 Key</option><option value="incomplete">缺少模型</option><option value="empty">无关内容</option><option value="image">截图</option></select></nav><div id="outside"><h1>供应商</h1><p>原有供应商和默认选择会被保留。</p><div id="providers"></div></div><iframe title="API 自动配置" src="/ui/import.html" hidden></iframe><script>const token=${JSON.stringify(token)};window.previewCall=async(path,body)=>{const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error('preview');return r.json();};document.querySelectorAll('[data-page]').forEach(b=>b.onclick=async()=>{await previewCall('page',{page:b.dataset.page});const active=b.dataset.page==='providers/custom/new';document.querySelector('iframe').hidden=!active;document.getElementById('outside').hidden=active;document.querySelector('#outside h1').textContent=b.textContent;});document.getElementById('scenario').onchange=e=>previewCall('fixture',{scenario:e.target.value});setInterval(async()=>{const d=await previewCall('state');const box=document.getElementById('providers');box.replaceChildren(...d.providers.map(p=>{const el=document.createElement('p');el.textContent=p.name+(p.default?' · 当前默认':' · 新添加');return el;}));},100);</script></html>`;}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){const server=await createPreviewServer(Number(process.env.PORT)||3478);console.log('Local integration preview: '+server.url);process.on('SIGINT',async()=>{await server.close();process.exit(0);});}
