export type Protocol = "chat-completions" | "responses" | "anthropic" | "unknown";
export interface Candidate {
  name: string;
  url: string;
  key: string;
  protocol: Protocol;
  model: string;
  models: string[];
  needsKeyReview: boolean;
}
export type Clipboard = { kind: "text"; text: string } | { kind: "image"; png: Uint8Array } | { kind: "empty" };
export interface Recognition { candidates: Candidate[]; issues: string[] }
export type Status = "idle" | "reading" | "selecting" | "incomplete" | "review" | "validating" | "verified" | "duplicate" | "dismissed" | "saving" | "saved" | "failed" | "unsupported";
export interface Receipt {
  fingerprint: string;
  model: string;
  protocol: "chat-completions";
  checkedAt: number;
  expiresAt: number;
}
export interface ViewState {
  status: Status;
  message: string;
  auto: boolean;
  active: boolean;
  candidates: Array<Omit<Candidate, "key"> & { maskedKey: string }>;
  selected: number;
  confirmation: null | { name: string; domain: string; maskedKey: string; protocol: string; model: string };
}
// Private controller adapter. These names are not public Magpie APIs.
export interface ImportHost {
  readClipboard(signal: AbortSignal): Promise<Clipboard>;
  exists(candidate: Candidate, signal: AbortSignal): Promise<boolean>;
  save(candidate: Candidate, receipt: Receipt, signal: AbortSignal): Promise<{ id: string }>;
  getAuto(): Promise<boolean>;
  setAuto(value: boolean): Promise<void>;
}
export interface OcrResult { text: string; keyReviewRequired: boolean }
export interface Ocr { recognize(png: Uint8Array, signal: AbortSignal): Promise<OcrResult> }
