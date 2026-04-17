// In-process mutex: serialises read-modify-write sequences against a named
// resource so two concurrent callers can't clobber each other's edits to the
// same JSON file. Good enough for a single-process dev server; if this ever
// runs on multiple instances, swap for a real lock (file lock / DB row lock).

const queues = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  // Swallow prior errors so one failed caller doesn't poison the chain.
  const next = prev.catch(() => undefined).then(fn);
  queues.set(
    key,
    next.catch(() => undefined)
  );
  try {
    return await next;
  } finally {
    // Drop the entry once this was the tail of the queue so the map doesn't
    // grow unbounded over the process lifetime.
    if (queues.get(key) === next) queues.delete(key);
  }
}
