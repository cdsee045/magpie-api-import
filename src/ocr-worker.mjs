import { createWorker, OEM } from 'tesseract.js';
import { createRequire } from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);
let worker;
try{
  const chunks=[];let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;if(size>20*1024*1024)throw Error('size');chunks.push(chunk);}
  worker=await createWorker('eng+chi_sim',OEM.LSTM_ONLY,{
    workerPath:require.resolve('tesseract.js/src/worker-script/node/index.js'),
    corePath:path.dirname(require.resolve('tesseract.js-core/package.json')),
    langPath:process.argv[2],cacheMethod:'none',gzip:true,logger:()=>{},errorHandler:()=>{},
  });
  const result=await worker.recognize(Buffer.concat(chunks));
  process.stdout.write(JSON.stringify({text:result.data.text}));
}catch{process.exitCode=1;}finally{await worker?.terminate().catch(()=>{});}
