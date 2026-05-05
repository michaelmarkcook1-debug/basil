/**
 * Local filesystem storage adapter.
 *
 * Used in development (when BLOB_READ_WRITE_TOKEN is absent).
 * Reads/writes JSON files under DATA_DIR, mirroring the same scope/key
 * structure as the Blob adapter.
 *
 * Scope "users/michael", key "sage-memory.json" →
 *   <DATA_DIR>/users/michael/sage-memory.json
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../paths";

function filePath(scope: string, key: string): string {
  return scope
    ? path.join(DATA_DIR, scope, key)
    : path.join(DATA_DIR, key);
}

async function ensureParentDir(p: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
}

export async function fsReadJson<T>(
  scope: string,
  key: string,
  fallback: T
): Promise<T> {
  try {
    const raw = await fs.readFile(filePath(scope, key), "utf8");
    const data = JSON.parse(raw);
    return (
      Array.isArray(fallback) ? (Array.isArray(data) ? data : fallback) : data
    ) as T;
  } catch {
    return fallback;
  }
}

export async function fsWriteJson<T>(
  scope: string,
  key: string,
  data: T
): Promise<void> {
  const p = filePath(scope, key);
  await ensureParentDir(p);
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
}

export async function fsDeleteJson(scope: string, key: string): Promise<void> {
  try {
    await fs.unlink(filePath(scope, key));
  } catch {
    // Ignore — file may not exist
  }
}

export async function fsListJson(scope: string): Promise<string[]> {
  const dir = scope ? path.join(DATA_DIR, scope) : DATA_DIR;
  try {
    const entries = await fs.readdir(dir);
    return entries.filter(
      (e) => e.endsWith(".json") && !e.startsWith("_")
    );
  } catch {
    return [];
  }
}
