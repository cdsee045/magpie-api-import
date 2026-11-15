import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { LocalOcr } from "../../src/ocr.ts";
import { parseText } from "../../src/parser.ts";
test("local Tesseract reads a synthetic screenshot and marks its key for review", async () => {
  const image = await readFile(new URL("../fixtures/api-screenshot.png", import.meta.url));
  const result = await new LocalOcr().recognize(image, new AbortController().signal);
  expect(result.keyReviewRequired).toBe(true);
  expect(result.text).toContain("api.example.test");
  const parsed = parseText(result.text, true);
  expect(parsed.candidates).toHaveLength(1);
  expect(parsed.candidates[0]?.needsKeyReview).toBe(true);
  expect(parsed.candidates[0]?.model).toBe("fixture-model");
}, 60_000);
test("invalid images and canceled OCR are rejected before processing", async () => {
  await expect(new LocalOcr().recognize(new Uint8Array([1,2]),new AbortController().signal)).rejects.toBeDefined();
  const abort = new AbortController();abort.abort();
  await expect(new LocalOcr().recognize(new Uint8Array(),abort.signal)).rejects.toBeDefined();
});
