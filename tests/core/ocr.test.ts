import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { LocalOcr } from "../../src/ocr.ts";
import { parseText } from "../../src/parser.ts";
import { urls, keys, models } from "../fixtures/shared-api.mjs";
import {urls as forumUrls,keys as forumKeys,models as forumModels} from '../fixtures/forum-api.mjs';
import {encodedReviewCandidate} from '../../src/precise-ocr.mjs';
test("offline OCR reads a synthetic screenshot and marks its key for review", async () => {
  const image = await readFile(new URL("../fixtures/api-screenshot.png", import.meta.url));
  const result = await new LocalOcr().recognize(image, new AbortController().signal);
  expect(result.keyReviewRequired).toBe(true);
  expect(result.engine).toBe("ppocr-v6");
  expect(result.text).toContain("api.example.test");
  const parsed = parseText(result.text, true);
  expect(parsed.candidates).toHaveLength(1);
  expect(parsed.candidates[0]?.needsKeyReview).toBe(true);
  expect(parsed.candidates[0]?.model).toBe("fixture-model");
  expect(parsed.candidates[0]?.key).toBe("fixture_test_ABCD1234567890");
}, 60_000);
test("local OCR finds three numbered wrapped keys, models and alternate addresses", async () => {
  const image = await readFile(new URL("../fixtures/shared-api-screenshot.png", import.meta.url));
  const result = await new LocalOcr().recognize(image, new AbortController().signal);
  expect(result.engine).toBe("ppocr-v6");
  const parsed = parseText(result.text, true);
  expect(parsed.candidates).toHaveLength(3);
  for (const [i, c] of parsed.candidates.entries()) {
    expect(c.name).toBe(`Key ${i + 1}`); expect(c.urlOptions).toEqual(urls);
    expect(c.url).toBe(urls[0]!); expect(c.models).toEqual(models[i]!);
    // The old non-hex font fixture contains indistinguishable I/l glyphs.
    // A differing candidate must be explicitly uncertain, never claimed exact.
    if(c.key!==keys[i]!) expect(result.keyReviewNote).toContain('无法确定完整 Key');
    expect(c.encodedKey?.length).toBeGreaterThan(70); expect(c.needsKeyReview).toBe(true);
    expect(c.models.length).toBe(i === 2 ? 1 : 2);
  }
}, 60_000);
for(const theme of ['light','dark'])test(`17px ${theme} screenshot retains every key byte, URL and dotted model ID`,async()=>{
  const result=await new LocalOcr().recognize(await readFile(new URL(`../fixtures/forum-${theme}.png`,import.meta.url)),new AbortController().signal);
  expect(result.engine).toBe('ppocr-v6'); const parsed=parseText(result.text,true);expect(parsed.candidates).toHaveLength(3);
  for(const[i,c]of parsed.candidates.entries()){
    expect(c.name).toBe(`Key ${i+1}`);expect(c.url).toBe(forumUrls[0]!);expect(c.urlOptions).toEqual(forumUrls);
    expect(c.key).toBe(forumKeys[i]!);expect(c.models).toEqual(forumModels[i]!);expect(c.needsKeyReview).toBe(true);
  }
},60000);
test('I/l format candidates stay explicitly inferred and do not alter arbitrary data',()=>{
  for(const key of forumKeys){const value=Buffer.from(key).toString('base64');expect(encodedReviewCandidate(value)).toEqual({encoded:value,inferred:false});}
  for(const value of ['not-an-encoding',Buffer.from('sk-fixture_mixed_CASE_123').toString('base64'),'I'.repeat(92)])expect(encodedReviewCandidate(value)).toEqual({encoded:value,inferred:false});
  const value=Buffer.from('sk-'+ 'e'.repeat(3)+'0'.repeat(61)).toString('base64');
  const position=value.indexOf('l');
  expect(position).toBeGreaterThanOrEqual(0);
  const changed=value.slice(0,position)+'I'+value.slice(position+1);expect(encodedReviewCandidate(changed)).toEqual({encoded:value,inferred:true});
});
test("invalid images and canceled OCR are rejected before processing", async () => {
  await expect(new LocalOcr().recognize(new Uint8Array([1,2]),new AbortController().signal)).rejects.toBeDefined();
  const abort = new AbortController();abort.abort();
  await expect(new LocalOcr().recognize(new Uint8Array(),abort.signal)).rejects.toBeDefined();
});
