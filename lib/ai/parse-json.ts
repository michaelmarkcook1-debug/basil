/**
 * AI JSON parsing utilities.
 *
 * parseAIJson     — legacy: strips fences + JSON.parse, TypeScript-cast only.
 *                   Use only where the caller immediately validates with Zod.
 *
 * parseAndValidate — preferred: strips fences, JSON.parse, Zod safeParse.
 *                   Returns { ok, data } or { ok: false, error, excerpt }.
 *                   Used by classifier paths (classify-email, classify-slack,
 *                   extract-meeting, process-meeting) that keep generateText
 *                   but need validated output.
 */

import type { z } from "zod";

// ── Fence stripping + JSON extraction ─────────────────────────────────────────

function extractJson(text: string): string {
  let s = text.trim();

  // Strip markdown fences
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }

  // Find outermost JSON object or array — handles leading prose from models
  const objStart = s.indexOf("{");
  const arrStart = s.indexOf("[");

  if (objStart === -1 && arrStart === -1) return s;

  if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
    const end = s.lastIndexOf("]");
    return end > arrStart ? s.slice(arrStart, end + 1) : s;
  }

  const end = s.lastIndexOf("}");
  return end > objStart ? s.slice(objStart, end + 1) : s;
}

// ── Legacy (unvalidated) ───────────────────────────────────────────────────────

/**
 * Near-JSON → JSON: bare Python literals (None / True / False / NaN) and
 * trailing commas, outside string values only. Models occasionally emit them —
 * '"implication": None' failed every meeting prep on 2026-10-13. Text inside
 * quotes is never touched. Pure — exported for tests.
 */
export function repairJsonLiterals(raw: string): string {
  const LITERALS: Record<string, string> = { None: "null", True: "true", False: "false", NaN: "null" };
  let out = "";
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (ch === "\\") { out += raw[++i] ?? ""; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    const word = /^[A-Za-z]+/.exec(raw.slice(i))?.[0];
    if (word) {
      out += LITERALS[word] ?? word;
      i += word.length - 1;
      continue;
    }
    if (ch === ",") {
      const rest = raw.slice(i + 1).match(/^\s*([}\]])/);
      if (rest) continue; // trailing comma
    }
    out += ch;
  }
  return out;
}

/**
 * Strip fences and JSON.parse. The TypeScript generic `<T>` is a cast only —
 * there is no runtime validation. Prefer `parseAndValidate` for new code.
 */
export function parseAIJson<T>(text: string): T {
  return JSON.parse(extractJson(text)) as T;
}

// ── Validated variant ─────────────────────────────────────────────────────────

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; excerpt: string; fieldErrors: string[] };

/**
 * Strip fences, JSON.parse, then validate with a Zod schema.
 *
 * @param text    Raw text from the AI model
 * @param schema  Zod schema to validate against
 * @param tag     Log prefix for error messages, e.g. "[classify-email]"
 */
export function parseAndValidate<T>(
  text: string,
  schema: z.ZodSchema<T>,
  tag: string
): ParseResult<T> {
  let raw: string;
  try {
    raw = extractJson(text);
  } catch {
    return {
      ok: false,
      error: "JSON extraction failed",
      excerpt: text.slice(0, 200),
      fieldErrors: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      // One repair pass for near-JSON (Python literals, trailing commas) before
      // throwing away a whole — already paid for — answer.
      parsed = JSON.parse(repairJsonLiterals(raw));
      console.warn(`${tag} repaired near-JSON output (${msg})`);
    } catch {
      console.error(`${tag} JSON.parse failed: ${msg}`, { excerpt: raw.slice(0, 200) });
      return {
        ok: false,
        error: `JSON parse error: ${msg}`,
        excerpt: raw.slice(0, 200),
        fieldErrors: [],
      };
    }
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { ok: true, data: result.data };
  }

  const fieldErrors = result.error.issues.map(
    (i) => `${i.path.join(".") || "root"}: ${i.message}`
  );
  const firstPath = result.error.issues[0]?.path.join(".") || "root";

  console.error(`${tag} Zod validation failed at "${firstPath}"`, {
    fieldErrors: fieldErrors.slice(0, 5),
    excerpt: raw.slice(0, 200),
  });

  return {
    ok: false,
    error: `Schema validation failed at "${firstPath}"`,
    excerpt: raw.slice(0, 200),
    fieldErrors,
  };
}
