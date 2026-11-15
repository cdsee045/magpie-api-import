import {PNG} from 'pngjs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as ort from '../vendor/ocr/runtime.mjs';

const asset = name => new URL('../vendor/ocr/' + name, import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Read only the public ONNX model's embedded character dictionary.
function protobufFields(bytes) {
  let offset = 0;
  const fields = [];
  function integer() {
    let value = 0, shift = 0, byte;
    do { if (offset >= bytes.length || shift > 49) throw Error('model'); byte = bytes[offset++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
    return value;
  }
  while (offset < bytes.length) {
    const tag = integer(), wire = tag & 7;
    if (wire === 2) { const size = integer(); if (offset + size > bytes.length) throw Error('model'); fields.push([tag >>> 3, bytes.subarray(offset, offset + size)]); offset += size; }
    else if (wire === 0) integer();
    else if (wire === 5) offset += 4;
    else if (wire === 1) offset += 8;
    else throw Error('model');
  }
  return fields;
}
function dictionary(model) {
  for (const [id, data] of protobufFields(model)) if (id === 14) {
    const pair = protobufFields(data);
    if (pair.find(([id]) => id === 1)?.[1].toString() === 'character') return ['', ...pair.find(([id]) => id === 2)[1].toString().split('\n'), ' '];
  }
  throw Error('dictionary');
}
const ink = (image, x, y) => {
  const p = (y * image.width + x) * 4;
  return image.data[p + 3] > 128 && Math.min(image.data[p], image.data[p + 1], image.data[p + 2]) < 175;
};
function rows(image) {
  const bands = [];
  let start = -1;
  for (let y = 0; y <= image.height; y++) {
    let count = 0;
    if (y < image.height) for (let x = 0; x < image.width; x++) if (ink(image, x, y)) count++;
    if (count >= 3) { if (start < 0) start = y; }
    else if (start >= 0) {
      if (y - start >= 7 && y - start <= 100) bands.push({y0: start, y1: y - 1});
      start = -1;
    }
  }
  if (bands.length > 120) throw Error('too many lines');
  return bands.flatMap(band => {
    let left = image.width, right = -1;
    for (let y = band.y0; y <= band.y1; y++) for (let x = 0; x < image.width; x++) if (ink(image, x, y)) { left = Math.min(left, x); right = Math.max(right, x); }
    if (right - left < 24) return [];
    return [{x0: Math.max(0, left - 2), x1: Math.min(image.width - 1, right + 2), y0: Math.max(0, band.y0 - 2), y1: Math.min(image.height - 1, band.y1 + 2)}];
  });
}
function inputTensor(image, box) {
  const sourceWidth = box.x1 - box.x0 + 1, sourceHeight = box.y1 - box.y0 + 1;
  const height = 48, resizedWidth = Math.ceil(height * sourceWidth / sourceHeight), width = Math.max(320, resizedWidth);
  if (width > 4096) throw Error('line too long');
  const data = new Float32Array(3 * height * width);
  for (let y = 0; y < height; y++) for (let x = 0; x < resizedWidth; x++) {
    const fx = Math.max(0, Math.min(image.width - 1, box.x0 + (x + .5) * sourceWidth / resizedWidth - .5));
    const fy = Math.max(0, Math.min(image.height - 1, box.y0 + (y + .5) * sourceHeight / height - .5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1), dx = fx - x0, dy = fy - y0;
    for (let channel = 0; channel < 3; channel++) {
      const pixel = (xx, yy) => image.data[(yy * image.width + xx) * 4 + channel];
      const value = (pixel(x0, y0) * (1 - dx) + pixel(x1, y0) * dx) * (1 - dy) + (pixel(x0, y1) * (1 - dx) + pixel(x1, y1) * dx) * dy;
      data[channel * height * width + y * width + x] = value / 127.5 - 1;
    }
  }
  return new ort.Tensor('float32', data, [1, 3, height, width]);
}
function coloredLink(image, box) {
  let left = image.width, right = -1;
  for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) {
    const p = (y * image.width + x) * 4, r = image.data[p], g = image.data[p + 1], b = image.data[p + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 55 && Math.min(r, g, b) < 160) { left = Math.min(left, x); right = Math.max(right, x); }
  }
  return right - left > 80 ? {...box, x0: Math.max(0, left - 2), x1: Math.min(image.width - 1, right + 2)} : null;
}
function trailingWord(image, box) {
  const groups = [];
  let left = -1, previous = -1;
  const gap = Math.max(5, Math.round((box.y1 - box.y0 - 3) * .3));
  for (let x = box.x0; x <= box.x1; x++) {
    let found = false;
    for (let y = box.y0; y <= box.y1; y++) if (ink(image, x, y)) { found = true; break; }
    if (!found) continue;
    if (left < 0) left = x;
    else if (x - previous >= gap) { groups.push({left, right: previous}); left = x; }
    previous = x;
  }
  if (left >= 0) groups.push({left, right: previous});
  return groups.length >= 2 ? {last: groups.at(-1), previous: groups.at(-2)} : null;
}
function canonicalKey(encoded) {
  try {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return '';
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch { return ''; }
}
// An I/l glyph can be identical in UI fonts. This is a *review candidate*,
// never proof of a credential and never authorization for a network call.
// Do not change arbitrary characters, enumerate endpoints or try keys online.
export function encodedReviewCandidate(encoded) {
  if (!encoded.startsWith('c2st') || encoded.length !== 92 || !/^[A-Za-z0-9+/|]+={2}$/.test(encoded)) return {encoded, inferred: false};
  if (/^sk-[a-f0-9]{64}$/.test(canonicalKey(encoded))) return {encoded, inferred: false};
  const positions = [...encoded].flatMap((char, index) => /[Il|]/.test(char) ? [index] : []);
  if (!positions.length || positions.length > 7) return {encoded, inferred: false};
  const matches = [];
  for (let mask = 0; mask < 2 ** positions.length; mask++) {
    const value = [...encoded]; positions.forEach((index, bit) => { value[index] = mask & 2 ** bit ? 'l' : 'I'; });
    const candidate = value.join('');
    if (/^sk-[a-f0-9]{64}$/.test(canonicalKey(candidate))) matches.push(candidate);
  }
  return matches.length === 1 ? {encoded: matches[0], inferred: true} : {encoded, inferred: false};
}
export async function recognizeScreenshot(png) {
  const manifest = JSON.parse(await readFile(asset('manifest.json'), 'utf8'));
  const [model, wasm] = await Promise.all([readFile(asset('recognizer.onnx')), readFile(asset('ort-wasm-simd-threaded.wasm'))]);
  if (hash(model) !== manifest.assets['recognizer.onnx'] || hash(wasm) !== manifest.assets['ort-wasm-simd-threaded.wasm']) throw Error('OCR asset integrity');
  ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.wasm.wasmBinary = wasm;
  ort.env.wasm.wasmPaths = {mjs: asset('ort-wasm-simd-threaded.mjs').href};
  const image = PNG.sync.read(Buffer.from(png));
  // Dark screenshots are inverted in memory; transparent pixels become white.
  const corners = [0, (image.width - 1) * 4, (image.height - 1) * image.width * 4, (image.width * image.height - 1) * 4];
  const dark = corners.filter(p => image.data[p] + image.data[p + 1] + image.data[p + 2] < 384).length >= 3;
  for (let p = 0; p < image.data.length; p += 4) for (let c = 0; c < 3; c++) image.data[p + c] = image.data[p + 3] < 128 ? 255 : dark ? 255 - image.data[p + c] : image.data[p + c];
  const chars = dictionary(model), session = await ort.InferenceSession.create(model, {executionProviders: ['wasm']});
  async function recognize(box) {
    const output = Object.values(await session.run({[session.inputNames[0]]: inputTensor(image, box)}))[0];
    const classes = output.dims.at(-1);
    if (classes !== chars.length) throw Error('dictionary mismatch');
    let previous = -1, text = '';
    for (let offset = 0; offset < output.data.length; offset += classes) {
      let best = 0;
      for (let index = 1; index < classes; index++) if (output.data[offset + index] > output.data[offset + best]) best = index;
      if (best && best !== previous) text += chars[best]; previous = best;
    }
    return text.trim();
  }
  try {
    const lines = [];
    for (const box of rows(image)) {
      let text = await recognize(box);
      // Colored hyperlink text excludes the grey forum counter next to it.
      if (/https?:/i.test(text)) {
        const linkBox = coloredLink(image, box);
        let refined = false;
        if (linkBox) {
          const link = (await recognize(linkBox)).match(/https?:\/\/[^\s<>]+/i)?.[0];
          if (link) { text = (/cdn|加速|备用/i.test(text.slice(0,Math.max(0,text.search(/https?:/i)))) ? 'url(CDN): ' : 'url: ') + link; refined = true; }
        }
        // A physically separate numeric badge is not part of an URL path.
        // Contiguous /123 paths remain intact, including black hyperlinks.
        if (!refined) {
          const words = trailingWord(image, box);
          if (words) {
            const last = await recognize({...box, x0: Math.max(box.x0, words.last.left - 2)});
            if (/^\d{1,5}$/.test(last)) text = await recognize({...box, x1: Math.min(box.x1, words.previous.right + 2)});
          }
        }
      }
      if (text) lines.push(text);
    }
    let inferred = false, uncertain = false;
    const encodedOriginals = [];
    for (let index = 0; index < lines.length; index++) if (/^(?:api\s*)?key\s*\d*\s*[(（]\s*base\s*64\s*[)）]\s*[:：]?\s*$/i.test(lines[index])) {
      const start = index + 1;
      let end = start;
      while (end < lines.length && /^[A-Za-z0-9+/|]+={0,2}$/.test(lines[end])) end++;
      if (end === start) continue;
      const original = lines.slice(start, end).join('');
      const result = encodedReviewCandidate(original);
      if (result.inferred) { lines[start] = result.encoded; for (let row = start + 1; row < end; row++) lines[row] = ''; inferred = true; encodedOriginals.push({encoded:result.encoded,original}); }
      else if (/[Il|]/.test(original) && !/^sk-[a-f0-9]{64}$/.test(canonicalKey(original))) uncertain = true;
    }
    return {text: lines.filter(Boolean).join('\n'), keyReviewRequired: true, engine: 'ppocr-v6', encodedOriginals, ...(inferred ? {keyReviewNote: '编码存在 I/l 相似字形；已按常见 sk-十六进制格式提供待核对候选，不能视为确定识别。可查看原始 OCR 结果，请核对完整 Key 后确认。'} : uncertain ? {keyReviewNote:'编码包含难以区分的 I/l 字形，无法确定完整 Key。未按其他格式改写；请逐字核对，或复制原文。'} : {})};
  } finally { await session.release(); }
}
