import { createSession } from "./src/host.ts";

// Stock Magpie accepts this OpenCode-shaped entry. It intentionally registers
// no fake provider and does not read the clipboard on plugin startup.
export default async function ApiImportPlugin() { return {}; }

// Magpie calls every exported function as a provider plugin, so integration
// helpers must remain on an object. createSession is for a future trusted-host
// implementation of the documented import contract, not a public Magpie hook.
export const _internal = { createSession };
