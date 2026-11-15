import { createWorker, OEM } from 'tesseract.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import {copyFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
let worker;
try{
  const chunks=[];let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;if(size>20*1024*1024)throw Error('size');chunks.push(chunk);}
  const png=Buffer.concat(chunks);
  try {
    const {recognizeScreenshot}=await import('./precise-ocr.mjs');
    process.stdout.write(JSON.stringify(await recognizeScreenshot(png)));
  } catch {
  await Promise.all(['eng','chi_sim'].map(code=>copyFile(path.join(path.dirname(require.resolve('@tesseract.js-data/'+code+'/package.json')),'4.0.0_best_int',code+'.traineddata.gz'),path.join(process.argv[2],code+'.traineddata.gz'))));
  worker=await createWorker('eng+chi_sim',OEM.LSTM_ONLY,{
    workerPath:require.resolve('tesseract.js/src/worker-script/node/index.js'),
    corePath:path.dirname(require.resolve('tesseract.js-core/package.json')),
    langPath:process.argv[2],cacheMethod:'none',gzip:true,logger:()=>{},errorHandler:()=>{},
  });
  const result=await worker.recognize(png);
  process.stdout.write(JSON.stringify({text:result.data.text,engine:'tesseract',keyReviewNote:'高精度识别不可用，本次使用兼容识别。请核对地址、模型和完整 Key，无法核对时请复制原文。'}));
  }
}catch{process.exitCode=1;}finally{await worker?.terminate().catch(()=>{});}
