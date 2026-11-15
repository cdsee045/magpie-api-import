// Reproduce vendored offline inference assets from pinned public sources.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const runtimeRoot=process.env.OCR_RUNTIME_ROOT || path.dirname(path.dirname(require.resolve('onnxruntime-web')));
if(JSON.parse(await readFile(path.join(runtimeRoot,'package.json'),'utf8')).version!=='1.31.1')throw Error('Runtime version mismatch');
const output=new URL('../vendor/ocr/',import.meta.url);await mkdir(output,{recursive:true});
const modelUrl='https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx';
const model=process.env.OCR_MODEL_FILE?await readFile(process.env.OCR_MODEL_FILE):Buffer.from(await (await fetch(modelUrl,{signal:AbortSignal.timeout(60000)})).arrayBuffer());
const hash=b=>createHash('sha256').update(b).digest('hex');
if(hash(model)!=='6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884')throw Error('OCR model checksum mismatch');
await writeFile(new URL('recognizer.onnx',output),model);
await build({entryPoints:[path.join(runtimeRoot,'dist/ort.node.min.mjs')],outfile:fileURLToPath(new URL('runtime.mjs',output)),platform:'node',target:'node22',format:'esm',bundle:true,minify:true,legalComments:'eof'});
for(const file of ['ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'])await copyFile(path.join(runtimeRoot,'dist',file),new URL(file,output));
for(const [repo,file,target]of [['microsoft/onnxruntime','LICENSE','ONNX-LICENSE.txt'],['microsoft/onnxruntime','ThirdPartyNotices.txt','ONNX-NOTICES.txt'],['RapidAI/RapidOCR','LICENSE','MODEL-LICENSE.txt']]){
 const response=await fetch(`https://api.github.com/repos/${repo}/contents/${file}`,{headers:{Accept:'application/vnd.github.raw+json'},signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error('Public license download failed');await writeFile(new URL(target,output),await response.text());
}
const assets={};for(const file of ['recognizer.onnx','runtime.mjs','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'])assets[file]=hash(await readFile(new URL(file,output)));
await writeFile(new URL('manifest.json',output),JSON.stringify({model:'PP-OCRv6_rec_small',modelSource:modelUrl,modelLicense:'Apache-2.0',runtime:'onnxruntime-web@1.31.1',runtimeLicense:'MIT',assets},null,2)+'\n');
console.log('Vendored public offline OCR model and single-threaded WASM runtime.');
