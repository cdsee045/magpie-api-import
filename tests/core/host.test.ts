import { describe, expect, test } from "bun:test";
import { createSession } from "../../src/host.ts";
import type { NativeHost } from "../../src/host.ts";
import type { ViewState } from "../../src/types.ts";
import { HttpValidator } from "../../src/validator.ts";
import { fingerprint } from "../../src/security.ts";
import { _internal } from "../../index.ts";
const fixture = {name:"fixture",url:"https://api.example.test/v1",key:"unit_test_key_123456789",model:"one"};
function setup() {
  let page="providers", listener=(p:string)=>{}, state:ViewState|undefined, saved=0;
  const native: NativeHost = {
    currentPage:()=>page,onPage(fn){listener=fn;return()=>{};},
    async readClipboard(){return {kind:"text",text:JSON.stringify(fixture)};},async hasProvider(){return false;},
    async appendProvider(input,signal){signal.throwIfAborted();expect(input.preserveDefaults).toBe(true);expect(input.verifiedModel).toBe("one");saved++;return {id:"new"};},
    options:{async get(){return {auto:true};},async set(){}},
  };
  const session=createSession(native,{validator:{async validate(c){const now=Date.now();return{fingerprint:fingerprint(c),model:c.model,protocol:"chat-completions",checkedAt:now,expiresAt:now+300_000};},async models(){return["one"];}}});
  session.subscribe(s=>state=s);
  return {session,enter(){page="providers/custom/new";listener(page);},leave(){page="agents";listener(page);},state:()=>state!,saved:()=>saved};
}
describe("trusted-host boundary",()=>{
  test("entry exports helpers on an object, never as phantom provider functions",()=>{expect(typeof _internal.createSession).toBe("function");});
  test("an iframe cannot activate itself or read a key outside the creation page",async()=>{
    const h=setup();await expect(h.session.command({type:"detect"})).rejects.toBeDefined();expect(()=>h.session.revealKey()).toThrow();h.session.dispose();
  });
  test("saves through the native host once and preserves existing defaults",async()=>{
    const h=setup();h.enter();await Bun.sleep(0);expect(h.state().status).toBe("verified");expect(JSON.stringify(h.state())).not.toContain(fixture.key);
    await h.session.command({type:"confirm"});await h.session.command({type:"confirm"});expect(h.saved()).toBe(1);h.session.dispose();
  });
  test("navigation revokes the session even when a valid confirmation existed",async()=>{
    const h=setup();h.enter();await Bun.sleep(0);h.leave();await expect(h.session.command({type:"confirm"})).rejects.toBeDefined();expect(h.saved()).toBe(0);h.session.dispose();
  });
  test("invalid command types and non-string fields cannot reach the parser or storage",async()=>{
    const h=setup();h.enter();await Bun.sleep(0);
    await expect(h.session.command({type:"edit",changes:{key:123 as unknown as string}})).rejects.toBeDefined();
    await expect(h.session.command({type:"unknown"} as never)).rejects.toBeDefined();h.session.dispose();
  });
});
