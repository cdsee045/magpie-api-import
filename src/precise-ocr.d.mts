import type {OcrResult} from './types.ts';
export function recognizeScreenshot(png:Uint8Array):Promise<OcrResult>;
export function encodedReviewCandidate(encoded:string):{encoded:string;inferred:boolean};
