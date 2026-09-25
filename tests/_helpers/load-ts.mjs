/**
 * Execute a real TypeScript module with its import boundaries mocked.
 *
 * The suite had 69 test files and not one of them imported an application
 * module — they read source text, or re-implemented the logic under test. That
 * is how two whole-app regressions shipped green in one month. This helper runs
 * the actual code: the file is transpiled in memory and evaluated in a fresh
 * context whose `require` resolves only the mocks you supply (plus `node:*`).
 * Anything unmocked throws, so a test cannot quietly reach a real store, a
 * real network, or the user's environment.
 *
 *   const store = loadTs("lib/events/store.ts", {
 *     "./lock": { withLock: (_k, fn) => fn() },
 *     "@/lib/storage/user-store": inMemoryUserStore(),
 *   });
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// LOAD_TS_ROOT lets a test run against another checkout of the same files —
// used to prove a fix's tests actually fail on the code before the fix.
const ROOT = process.env.LOAD_TS_ROOT ? path.resolve(process.env.LOAD_TS_ROOT) : PROJECT;
const require = createRequire(import.meta.url);
const ts = require(path.join(PROJECT, "node_modules/typescript"));

export function loadTs(relative, mocks = {}, env = {}) {
  const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: relative,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const mod = { exports: {} }; // the sandbox global is named `module`; this local is not
  const restrictedRequire = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id.startsWith("node:")) return require(id);
    // Next's boundary markers have no runtime behaviour; every test would stub them.
    if (id === "server-only" || id === "client-only") return {};
    throw new Error(`[load-ts] ${relative} required "${id}" and no mock was supplied`);
  };
  vm.runInNewContext(outputText, {
    module: mod, exports: mod.exports, require: restrictedRequire,
    console, Buffer, Date, Error, URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone,
    setTimeout, clearTimeout, setImmediate, queueMicrotask,
    // WHATWG globals route handlers and the AI SDK rely on. Same objects as
    // this realm so a Response built inside can be read outside.
    Response, Request, Headers, fetch, AbortController, AbortSignal, ReadableStream, TransformStream, Blob, FormData,
    crypto: globalThis.crypto,
    process: { env, nextTick: process.nextTick },
  }, { filename: relative });
  return mod.exports;
}

/** A real per-key mutex — so concurrent-request tests actually contend. */
export function makeLock() {
  const chains = new Map();
  return {
    withLock(key, fn) {
      const prev = chains.get(key) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      chains.set(key, run.catch(() => undefined));
      return run;
    },
  };
}

/** The NextResponse surface a route handler uses. */
export const nextServer = {
  NextResponse: {
    json: (body, init = {}) => ({
      status: init.status ?? 200, body, headers: init.headers ?? {},
      // Routes clear or set cookies on the response; record, don't act.
      cookies: { set() {}, delete() {}, get() { return undefined; } },
    }),
  },
};
