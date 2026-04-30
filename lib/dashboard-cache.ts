/**
 * Lightweight in-memory cache for dashboard data fetched from the API.
 *
 * Module-level (not React state) so it survives SPA navigations —
 * a page unmounting and remounting sees the same cached data instantly.
 *
 * Usage in a page:
 *
 *   const refresh = useCallback(async () => {
 *     // Serve stale data immediately — eliminates blank flash on tab switch
 *     const cached = dashboardCache.get<ActionItem[]>("actions");
 *     if (cached) setActions(cached);
 *
 *     // Always revalidate in the background
 *     const res = await fetch("/api/actions", { cache: "no-store" });
 *     const data = await res.json();
 *     const fresh = data.actions ?? [];
 *     dashboardCache.set("actions", fresh);
 *     setActions(fresh);
 *   }, []);
 */

type Entry<T> = { data: T; at: number };

class DashboardCache {
  private store = new Map<string, Entry<unknown>>();
  /** How long a cache entry is considered fresh (milliseconds). */
  private ttl: number;

  constructor(ttlMs = 60_000) {
    this.ttl = ttlMs;
  }

  get<T>(key: string): T | null {
    const e = this.store.get(key);
    if (!e) return null;
    if (Date.now() - e.at > this.ttl) {
      this.store.delete(key);
      return null;
    }
    return e.data as T;
  }

  set<T>(key: string, data: T): void {
    this.store.set(key, { data, at: Date.now() });
  }

  /** Force-expire a key (call before a mutation to avoid serving stale data). */
  bust(key: string): void {
    this.store.delete(key);
  }

  /** Force-expire all keys. */
  bustAll(): void {
    this.store.clear();
  }
}

export const dashboardCache = new DashboardCache(60_000);
