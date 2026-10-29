/**
 * lib/uploads/store.ts — the user's uploads.
 *
 * `uploads.json` holds the small records (one per file); the text of each
 * upload — transcript segments or document text — lives in its own file so
 * the list stays cheap to read. The original sits in private Blob storage.
 */
import "server-only";
import { readUserStore, updateUserStore, writeUserStore } from "@/lib/storage/user-store";
import type { Segment, UploadRecord } from "./shape";

const FILE = "uploads.json";
const textFile = (id: string) => `upload-text-${id}.json`;

export interface UploadText {
  /** Timestamped transcript (recordings and caption files). */
  segments?: Segment[];
  /** Plain text (documents). */
  text?: string;
}

export async function listUploads(username: string): Promise<UploadRecord[]> {
  const all = await readUserStore<UploadRecord[]>(username, FILE, [], { fresh: true });
  return [...all].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

export async function getUpload(username: string, id: string): Promise<UploadRecord | null> {
  return (await listUploads(username)).find((u) => u.id === id) ?? null;
}

export async function saveUpload(username: string, record: UploadRecord): Promise<void> {
  await updateUserStore<UploadRecord[]>(username, FILE, (cur) => [...cur.filter((u) => u.id !== record.id), record], []);
}

export async function patchUpload(username: string, id: string, patch: Partial<UploadRecord>): Promise<UploadRecord | null> {
  let out: UploadRecord | null = null;
  await updateUserStore<UploadRecord[]>(username, FILE, (cur) => cur.map((u) => {
    if (u.id !== id) return u;
    out = { ...u, ...patch, updatedAt: new Date().toISOString() };
    return out;
  }), []);
  return out;
}

export async function removeUpload(username: string, id: string): Promise<void> {
  await updateUserStore<UploadRecord[]>(username, FILE, (cur) => cur.filter((u) => u.id !== id), [], { allowShrink: true });
  await writeUserStore<UploadText>(username, textFile(id), {});
}

export async function saveUploadText(username: string, id: string, t: UploadText): Promise<void> {
  await writeUserStore<UploadText>(username, textFile(id), t);
}

export async function getUploadText(username: string, id: string): Promise<UploadText> {
  return readUserStore<UploadText>(username, textFile(id), {}, { fresh: true });
}
