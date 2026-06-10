/**
 * Named read-modify-write lock used by the per-user JSON stores.
 *
 * This was historically an in-process mutex — fine for a single dev server, but
 * a no-op across Vercel's autoscaled instances, where two instances could still
 * clobber the same file. It now delegates to the cross-instance lock
 * (lib/storage/lock.ts), which uses Upstash Redis when configured and falls
 * back to the in-process behaviour otherwise. Every store that imports withLock
 * from here (actions, decisions, contacts, memory, chat, ingest, jobs, …) is
 * thereby serialized correctly under multi-instance load with no per-store
 * change.
 */

export { withLock } from "@/lib/storage/lock";
