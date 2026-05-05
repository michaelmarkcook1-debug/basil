/**
 * generateValidated — structured AI generation with schema validation + one repair retry.
 *
 * Wraps the AI SDK v6 `generateText` + `Output.object / Output.array` pattern.
 * On schema validation failure:
 *   1. Logs the failing schema path and a model output excerpt.
 *   2. Retries once with the original prompt appended with a repair instruction
 *      that names the specific fields that failed.
 *   3. If the retry also fails, throws `AIValidationError` — callers must catch
 *      this and return 422 (API routes) or a safe fallback (classifiers).
 *
 * Usage (object):
 *   const profile = await generateValidated({
 *     schema: ContactProfileSchema,
 *     schemaName: "ContactProfile",
 *     kind: "object",
 *     model: getTextModel(),
 *     maxOutputTokens: MAX_TOKENS.default,
 *     system,
 *     prompt,
 *     tag: "contact-profile",
 *   });
 *
 * Usage (array):
 *   const items = await generateValidated({
 *     elementSchema: MemoryItemSchema,
 *     schemaName: "MemoryItem",
 *     kind: "array",
 *     ...
 *   });
 */

import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";

// ── Error type ─────────────────────────────────────────────────────────────────

export class AIValidationError extends Error {
  constructor(
    /** The Zod path of the first field that failed validation, e.g. "actions.0.text" */
    public readonly schemaPath: string,
    /** First 300 chars of the raw model output for log correlation */
    public readonly modelExcerpt: string,
    /** Human-readable field error messages from Zod */
    public readonly fieldErrors: string[]
  ) {
    super(
      `AI output validation failed at "${schemaPath}": ${fieldErrors.slice(0, 3).join("; ")}`
    );
    this.name = "AIValidationError";
  }
}

// ── Shared options ─────────────────────────────────────────────────────────────

interface BaseOpts {
  model: LanguageModel;
  maxOutputTokens: number;
  system: string;
  prompt: string;
  tag: string;
  providerOptions?: ProviderOptions;
}

interface ObjectOpts<T> extends BaseOpts {
  kind: "object";
  schema: z.ZodSchema<T>;
  schemaName: string;
  schemaDescription?: string;
}

interface ArrayOpts<T> extends BaseOpts {
  kind: "array";
  elementSchema: z.ZodSchema<T>;
  schemaName: string;
  schemaDescription?: string;
}

type Opts<T> = ObjectOpts<T> | ArrayOpts<T>;

// ── Core helper ────────────────────────────────────────────────────────────────

/**
 * Generate validated structured output with one automatic repair retry.
 * Throws `AIValidationError` if both attempts fail.
 */
export async function generateValidated<T>(opts: Opts<T>): Promise<T> {
  async function attempt(repairHint?: string): Promise<T> {
    const system = repairHint
      ? `${opts.system}\n\n---\nIMPORTANT: Your previous response failed validation. ${repairHint}\nReturn ONLY valid JSON that exactly matches the required schema. No extra keys, no markdown fences, no commentary.`
      : opts.system;

    const output =
      opts.kind === "object"
        ? Output.object<T>({
            schema: opts.schema,
            name: opts.schemaName,
            ...(opts.schemaDescription
              ? { description: opts.schemaDescription }
              : {}),
          })
        : Output.array<T>({
            element: (opts as ArrayOpts<T>).elementSchema,
            name: opts.schemaName,
            ...(opts.schemaDescription
              ? { description: opts.schemaDescription }
              : {}),
          });

    const result = await generateText({
      model: opts.model,
      maxOutputTokens: opts.maxOutputTokens,
      output,
      system,
      prompt: opts.prompt,
      ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
    });

    return result.output as T;
  }

  // ── Attempt 1 ─────────────────────────────────────────────────────────────

  let schemaPath = "unknown";
  let modelExcerpt = "";
  let fieldErrors: string[] = [];
  let repairHint = "Ensure all required fields are present with the correct types.";

  try {
    return await attempt();
  } catch (err) {
    // Extract diagnostic info from NoObjectGeneratedError or Zod error
    if (NoObjectGeneratedError.isInstance(err)) {
      modelExcerpt = (err.text ?? "").slice(0, 300);
      const cause = err.cause as { issues?: { path: unknown[]; message: string }[] } | undefined;
      if (cause?.issues?.length) {
        fieldErrors = cause.issues.map(
          (i) => `${Array.isArray(i.path) ? i.path.join(".") : String(i.path)}: ${i.message}`
        );
        schemaPath = cause.issues[0]
          ? (Array.isArray(cause.issues[0].path)
              ? cause.issues[0].path.join(".")
              : String(cause.issues[0].path)) || "root"
          : "root";
        repairHint = `Schema validation errors: ${fieldErrors.slice(0, 3).join("; ")}`;
      } else {
        repairHint = `The response could not be parsed as valid JSON matching the "${opts.schemaName}" schema.`;
      }
    } else if (err instanceof Error) {
      modelExcerpt = err.message.slice(0, 300);
    }

    console.error(`[${opts.tag}] AI output validation — attempt 1 failed`, {
      schemaPath,
      fieldErrors: fieldErrors.slice(0, 5),
      excerpt: modelExcerpt.slice(0, 200),
    });
  }

  // ── Attempt 2 (repair) ────────────────────────────────────────────────────

  try {
    return await attempt(repairHint);
  } catch (retryErr) {
    const retryExcerpt = NoObjectGeneratedError.isInstance(retryErr)
      ? (retryErr.text ?? "").slice(0, 300)
      : retryErr instanceof Error
        ? retryErr.message.slice(0, 300)
        : String(retryErr).slice(0, 300);

    console.error(`[${opts.tag}] AI output validation — attempt 2 failed (giving up)`, {
      schemaPath,
      fieldErrors: fieldErrors.slice(0, 5),
      retryExcerpt: retryExcerpt.slice(0, 200),
    });

    throw new AIValidationError(schemaPath, modelExcerpt, fieldErrors);
  }
}

// ── Response helper for API routes ────────────────────────────────────────────

/**
 * Standard 422 response body for AI validation failures.
 * Import and use in route handlers that catch AIValidationError.
 */
export function aiValidationErrorResponse(err: AIValidationError) {
  return {
    error: "generation_failed",
    hint: "The AI response was malformed. Please try again.",
    code: "AI_VALIDATION_ERROR",
    // Safe for client — no raw model output, no PII
    detail: `Schema path: ${err.schemaPath}`,
  };
}
