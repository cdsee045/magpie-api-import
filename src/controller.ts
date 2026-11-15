import type { Candidate, ImportHost, Ocr, Receipt, Status, ViewState } from "./types.ts";
import { candidateIssues, configFingerprint, digest, fingerprint, maskKey, normalizeUrl, publicError } from "./security.ts";
import { parseText } from "./parser.ts";
import type { Validator } from "./validator.ts";

export class ImportController {
  private active = false;
  private auto = true;
  private sequence = 0;
  private running = new AbortController();
  private candidates: Candidate[] = [];
  private selected = 0;
  private receipt: Receipt | null = null;
  private status: Status = "idle";
  private message = "";
  private seen = new Map<string, number>();
  private imported = new Map<string, number>();
  private seenConfigs = new Map<string, number>();
  private listeners = new Set<(state: ViewState) => void>();
  private disposed = false;
  constructor(private readonly host: ImportHost, private readonly validator: Validator, private readonly ocr: Ocr, private readonly now = Date.now) {}

  snapshot(): ViewState {
    const chosen = this.candidates[this.selected];
    return {
      status: this.status, message: this.message, auto: this.auto, active: this.active,
      candidates: this.candidates.map(({ key, ...c }) => ({ ...c, models: [...c.models], maskedKey: maskKey(key) })), selected: this.selected,
      confirmation: this.active && this.status === "verified" && chosen && this.receipt ? {
        name: chosen.name, domain: new URL(chosen.url).host, maskedKey: maskKey(chosen.key), protocol: "Chat Completions", model: this.receipt.model,
      } : null,
    };
  }
  subscribe(listener: (state: ViewState) => void): () => void { this.listeners.add(listener); listener(this.snapshot()); return () => this.listeners.delete(listener); }
  revealKey(): string { return this.active && !this.disposed ? this.candidates[this.selected]?.key ?? "" : ""; }
  private emit(): void { const state = this.snapshot(); for (const listener of this.listeners) { try { listener(state); } catch { /* UI errors must not expose raw controller data. */ } } }
  private update(status: Status, message = ""): void { this.status = status; this.message = message; this.emit(); }
  private cancel(): number { this.running.abort(); this.running = new AbortController(); this.receipt = null; return ++this.sequence; }
  private live(sequence: number): boolean { return this.active && !this.disposed && sequence === this.sequence && !this.running.signal.aborted; }
  private remembered(map: Map<string, number>, key: string): boolean {
    const now = this.now();
    for (const [k, until] of map) if (until <= now) map.delete(k);
    return map.has(key);
  }
  private remember(map: Map<string, number>, key: string): void { if (map.size >= 100) map.delete(map.keys().next().value!); map.set(key, this.now() + 600_000); }

  // Only the exact creation page is allowed, never a saved provider editor.
  async setPage(page: string): Promise<void> {
    if (this.disposed) return;
    const next = page === "providers/custom/new";
    if (this.active === next) return;
    this.cancel(); this.active = next; this.candidates = []; this.selected = 0;
    this.update("idle");
    if (!next) return;
    const seq = this.sequence;
    try { const auto = await this.host.getAuto(); if (!this.live(seq)) return; this.auto = auto; this.emit(); }
    catch { if (this.live(seq)) this.update("failed", "无法读取自动识别设置，请手动重新检测。"); return; }
    if (this.auto) await this.detect();
  }
  async setAuto(value: boolean): Promise<void> {
    if (this.disposed) return;
    this.auto = value;
    if (!value) { this.cancel(); this.candidates = []; this.update("idle"); } else this.emit();
    try { await this.host.setAuto(value); }
    catch { if (this.active) this.update("failed", "自动识别设置保存失败，请重试。"); }
  }
  async detect(manual = false): Promise<void> {
    if (!this.active || this.disposed || (!manual && !this.auto) || this.status === "saving") return;
    const seq = this.cancel(), signal = this.running.signal;
    this.candidates = []; this.selected = 0; this.update("reading", "正在本地识别剪贴板…");
    try {
      let clipboard = await this.host.readClipboard(signal);
      if (!this.live(seq)) return;
      if (clipboard.kind === "empty") { this.update("idle"); return; }
      const hash = digest(clipboard.kind === "text" ? `text:${clipboard.text}` : clipboard.png);
      if (!manual && this.remembered(this.seen, hash)) { this.update("dismissed", "该内容已检测过；可手动重新检测。"); return; }
      let text: string, image = false;
      if (clipboard.kind === "image") {
        const result = await this.ocr.recognize(clipboard.png, signal);
        if (!this.live(seq)) return;
        text = result.text; image = true;
      } else text = clipboard.text;
      clipboard = { kind: "empty" };
      const result = parseText(text, image);
      text = "";
      if (!this.live(seq)) return;
      this.candidates = result.candidates;
      if (result.candidates.length || result.issues.length) this.remember(this.seen, hash);
      if (!this.candidates.length) { this.update(result.issues.length ? "incomplete" : "idle", result.issues.join(" ")); return; }
      if (this.candidates.length > 1) { this.update("selecting", `识别到 ${this.candidates.length} 条配置，请选择一条验证并导入。`); return; }
      await this.verify(manual);
    } catch (error) { if (this.live(seq)) this.update("failed", publicError(error)); }
  }
  async select(index: number): Promise<void> {
    if (!this.active || this.status === "saving" || !Number.isInteger(index) || !this.candidates[index]) return;
    this.cancel(); this.selected = index; await this.verify();
  }
  edit(changes: Partial<Pick<Candidate, "name" | "url" | "key" | "model" | "protocol">>, reviewed = false): void {
    if (!this.active || this.status === "saving") return;
    this.cancel();
    let chosen = this.candidates[this.selected];
    if (!chosen) { chosen = { name: "我的 API", url: "", key: "", protocol: "chat-completions", model: "", models: [], needsKeyReview: false }; this.candidates = [chosen]; this.selected = 0; }
    Object.assign(chosen, changes);
    if (reviewed) chosen.needsKeyReview = false;
    this.update("incomplete", "配置已修改，请重新验证。验证可能产生少量费用。");
  }
  async loadModels(): Promise<void> {
    const chosen = this.candidates[this.selected];
    if (!this.active || !chosen || this.status === "saving") return;
    const seq = this.cancel(), signal = this.running.signal;
    this.update("reading", "正在获取模型列表；获取列表不代表验证通过。");
    try {
      const models = await this.validator.models({ ...chosen }, signal);
      if (!this.live(seq)) return;
      chosen.models = models;
      this.update("incomplete", models.length ? "请选择一个模型，再进行真实调用验证。" : "未找到模型，请手动填写。");
    } catch (error) { if (this.live(seq)) this.update("failed", publicError(error)); }
  }
  async verify(manual = true): Promise<void> {
    const chosen = this.candidates[this.selected];
    if (!this.active || !chosen || this.status === "saving") return;
    const seq = this.cancel(), signal = this.running.signal;
    const issues = candidateIssues(chosen);
    if (issues.length) { this.update(chosen.needsKeyReview ? "review" : "incomplete", issues.join(" ")); return; }
    chosen.url = normalizeUrl(chosen.url);
    const copy = { ...chosen, models: [...chosen.models] };
    const binding = fingerprint(copy);
    if (!manual && this.remembered(this.seenConfigs, binding)) { this.update("dismissed", "该配置已检测过；可手动重新验证。"); return; }
    this.remember(this.seenConfigs, binding);
    this.update("validating", "正在进行最小真实调用，可能产生少量费用…");
    try {
      const identity = configFingerprint(copy);
      if (this.remembered(this.imported, identity) || await this.host.exists(copy, signal)) {
        if (this.live(seq)) this.update("duplicate", "该地址、Key 和协议的配置已存在。"); return;
      }
      if (!this.live(seq)) return;
      const receipt = await this.validator.validate(copy, signal);
      if (!this.live(seq) || fingerprint(chosen) !== receipt.fingerprint || receipt.expiresAt <= this.now()) return;
      this.receipt = receipt;
      this.update("verified", "真实调用验证通过，确认后添加。其他模型保持未验证。");
    } catch (error) { if (this.live(seq)) this.update("failed", publicError(error)); }
  }
  dismiss(): void {
    if (!this.active || this.status === "saving") return;
    this.cancel(); this.candidates = []; this.update("dismissed", "本次未添加；可手动重新检测。");
  }
  async confirm(): Promise<boolean> {
    const chosen = this.candidates[this.selected], receipt = this.receipt;
    if (!this.active || this.status !== "verified" || !chosen || !receipt) return false;
    if (receipt.expiresAt <= this.now() || receipt.fingerprint !== fingerprint(chosen)) {
      this.cancel(); this.update("incomplete", "验证已过期或配置发生变化，请重新验证。"); return false;
    }
    const seq = this.sequence, signal = this.running.signal;
    this.update("saving", "正在添加供应商…");
    try {
      if (await this.host.exists(chosen, signal)) { if (this.live(seq)) { this.receipt = null; this.update("duplicate", "该配置已存在。"); } return false; }
      if (!this.live(seq)) return false;
      await this.host.save({ ...chosen, models: [...chosen.models] }, { ...receipt }, signal);
      if (!this.live(seq)) return false;
      this.remember(this.imported, configFingerprint(chosen)); this.receipt = null; this.candidates = [];
      this.update("saved", "供应商已添加，原有默认选择保持不变。"); return true;
    } catch (error) { if (this.live(seq)) { this.receipt = null; this.update("failed", publicError(error)); } return false; }
  }
  dispose(): void { this.cancel(); this.disposed = true; this.active = false; this.candidates = []; this.seen.clear(); this.imported.clear(); this.seenConfigs.clear(); this.listeners.clear(); }
}
