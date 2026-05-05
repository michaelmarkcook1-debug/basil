#!/usr/bin/env node
/**
 * check-model-usage.mjs
 *
 * Enforces that no file outside lib/ai/model-config.ts hardcodes AI model IDs
 * or imports directly from provider SDKs (@ai-sdk/anthropic, @anthropic-ai/sdk).
 *
 * Run:   node scripts/check-model-usage.mjs
 * CI:    add to package.json scripts → "check:models": "node scripts/check-model-usage.mjs"
 *
 * Exit codes:
 *   0 — all clear
 *   1 — violations found (prints each one)
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MODEL_CONFIG_PATH = "lib/ai/model-config.ts";

// Directories to scan (relative to repo root)
const SCAN_DIRS = ["app", "lib", "components", "scripts"];

// Files that are explicitly allowed to contain these patterns
const ALLOWLIST = new Set([
  MODEL_CONFIG_PATH,
  // Scripts that legitimately reference model names as strings (not API calls)
  "scripts/check-model-usage.mjs",
]);

// ── Forbidden patterns ─────────────────────────────────────────────────────────

/** Direct provider SDK imports — all model calls must go through model-config */
const FORBIDDEN_IMPORTS = [
  { pattern: /@ai-sdk\/anthropic/, label: 'Direct @ai-sdk/anthropic import — use getTextModel() from model-config' },
  { pattern: /@anthropic-ai\/sdk/, label: 'Direct @anthropic-ai/sdk import — use getTextModel() from model-config' },
  { pattern: /@ai-sdk\/openai/,    label: 'Direct @ai-sdk/openai import — use getTextModel() from model-config' },
  { pattern: /@ai-sdk\/google/,    label: 'Direct @ai-sdk/google import — use getTextModel() from model-config' },
];

/**
 * Hardcoded model ID strings.
 * Matches patterns like: "claude-sonnet-4-5", "claude-haiku-4.5", anthropic("claude-…"),
 * gateway("anthropic/claude-…"), openai("gpt-…"), etc.
 *
 * Intentionally does NOT flag "claude-code" or "claude-chat" since those are
 * AI project platform identifiers, not model IDs passed to the AI SDK.
 */
const FORBIDDEN_MODEL_IDS = [
  {
    // claude-* model IDs (e.g. claude-sonnet-4-5, claude-haiku-4.5, claude-3-5-sonnet-20240620)
    pattern: /["'`](claude-(?:sonnet|haiku|opus|instant|3)[^"'`]*?)["'`]/,
    label: 'Hardcoded Claude model ID — use GATEWAY_MODEL_IDS from model-config',
  },
  {
    // gpt-* model IDs
    pattern: /["'`](gpt-[^"'`]+?)["'`]/,
    label: 'Hardcoded GPT model ID — use getTextModel() from model-config',
  },
  {
    // anthropic/claude-* gateway slugs
    pattern: /["'`](anthropic\/claude-[^"'`]+?)["'`]/,
    label: 'Hardcoded gateway model slug — use GATEWAY_MODEL_IDS from model-config',
  },
  {
    // openai/* gateway slugs
    pattern: /["'`](openai\/[^"'`]+?)["'`]/,
    label: 'Hardcoded gateway model slug — use GATEWAY_MODEL_IDS from model-config',
  },
];

// ── File scanner ───────────────────────────────────────────────────────────────

async function* walkTs(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory may not exist
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") continue;
      yield* walkTs(full);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") || entry.name.endsWith(".mjs"))) {
      yield full;
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

let violations = 0;

for (const scanDir of SCAN_DIRS) {
  const absDir = join(ROOT, scanDir);
  for await (const absPath of walkTs(absDir)) {
    const relPath = relative(ROOT, absPath);

    if (ALLOWLIST.has(relPath)) continue;

    const content = await readFile(absPath, "utf8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Skip comment lines
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;

      // Check forbidden imports
      for (const { pattern, label } of FORBIDDEN_IMPORTS) {
        if (pattern.test(line)) {
          console.error(`\x1b[31m✗\x1b[0m ${relPath}:${lineNum}  ${label}`);
          console.error(`    ${line.trim()}`);
          violations++;
        }
      }

      // Check hardcoded model IDs (only in lines that look like SDK calls)
      // Avoid flagging seed data, comments about model names, etc.
      const looksLikeModelCall = /model:|anthropic\(|gateway\(|openai\(|generateText|streamText/.test(line);
      if (looksLikeModelCall) {
        for (const { pattern, label } of FORBIDDEN_MODEL_IDS) {
          const match = line.match(pattern);
          if (match) {
            console.error(`\x1b[31m✗\x1b[0m ${relPath}:${lineNum}  ${label}`);
            console.error(`    ${line.trim()}`);
            violations++;
          }
        }
      }
    }
  }
}

if (violations === 0) {
  console.log("\x1b[32m✓\x1b[0m No hardcoded model IDs or direct provider imports found.");
  process.exit(0);
} else {
  console.error(`\n\x1b[31m${violations} violation(s) found.\x1b[0m`);
  console.error("All model IDs must be defined in lib/ai/model-config.ts.");
  console.error("Use getTextModel(\"fast\" | \"default\" | \"long\") at every call site.");
  process.exit(1);
}
