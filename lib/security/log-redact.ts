/**
 * Strip credentials from server log lines (2026-11-13).
 *
 * The production logs held a Google refresh token in full: a failed refresh
 * logged the whole googleapis error, whose request body carries the token
 * (gaxios redacts the client secret but not the refresh token). About 45 log
 * calls print whole provider errors, so instrumentation.ts runs every console
 * line through this instead of trusting each call site.
 */
import { inspect } from "node:util";

const PATTERNS: [RegExp, string][] = [
  [/\b1\/\/0[0-9A-Za-z_-]{20,}/g, "[google-refresh-token]"],
  [/\bya29\.[0-9A-Za-z._-]{20,}/g, "[google-access-token]"],
  [/\bxox[abposre]-[A-Za-z0-9-]{10,}/g, "[slack-token]"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, "[api-key]"],
  [/\bre_[A-Za-z0-9_]{20,}/g, "[resend-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[github-token]"],
  [/\blin_api_[A-Za-z0-9]{20,}/g, "[linear-key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[token]"],
  // Named fields in any serialisation: refresh_token' => '…', "access_token":"…", client_secret=…
  [/((?:refresh_token|access_token|id_token|client_secret|webhookSecret|apiKey|api_key|password)["']?\s*(?:=>|:|=)\s*["']?)[^"'\s,&}]{8,}/gi, "$1[redacted]"],
];

export function redactLogText(text: string): string {
  let out = text;
  for (const [re, sub] of PATTERNS) out = out.replace(re, sub);
  return out;
}

/** One console argument → a safe value. Strings are redacted; objects and errors are rendered, then redacted. */
export function redactLogArg(arg: unknown): unknown {
  if (typeof arg === "string") return redactLogText(arg);
  if (arg === null || typeof arg !== "object") return arg;
  return redactLogText(inspect(arg, { depth: 4, breakLength: Infinity }));
}

let installed = false;

/** Wrap console.log/info/warn/error/debug once per process. */
export function installLogRedaction(target: Pick<Console, "log" | "info" | "warn" | "error" | "debug"> = console): void {
  if (installed && target === console) return;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => original(...args.map(redactLogArg));
  }
  if (target === console) installed = true;
}
