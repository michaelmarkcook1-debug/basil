/**
 * basilFetch — typed fetch wrapper for Basil client components.
 *
 * Replaces the common pattern of `fetch(...).then(r => r.json()).catch(() => {})`
 * with a helper that:
 *   - Checks res.ok and throws typed errors instead of silently returning null
 *   - Parses the JSON error body from non-ok responses
 *   - Logs every failure to the console with route, status, and component name
 *   - Maps HTTP status codes to semantic error kinds
 *
 * Usage:
 *   const data = await basilFetch<MyType>("/api/foo", { component: "MyComponent" });
 *
 * Catching typed errors:
 *   try {
 *     const data = await basilFetch<MyType>("/api/foo", { component: "Foo" });
 *   } catch (e) {
 *     if (e instanceof BasilFetchError) {
 *       if (e.kind === "auth_error") { ... }
 *     }
 *   }
 */

export type FetchErrorKind =
  | "auth_error"         // 401 — session expired or not signed in
  | "permission_missing" // 403 — signed in but lacks access
  | "not_found"          // 404 — route / resource missing (config bug)
  | "timeout"            // 408 / 504 / 524 — upstream took too long
  | "server_error"       // 5xx — backend threw
  | "network_error";     // fetch threw — offline, DNS failure, etc.

export class BasilFetchError extends Error {
  readonly kind: FetchErrorKind;
  readonly status?: number;
  readonly serverMessage?: string;

  constructor(
    kind: FetchErrorKind,
    message: string,
    status?: number,
    serverMessage?: string,
  ) {
    super(message);
    this.name = "BasilFetchError";
    this.kind = kind;
    this.status = status;
    this.serverMessage = serverMessage;
  }
}

function kindFromStatus(status: number): FetchErrorKind {
  if (status === 401) return "auth_error";
  if (status === 403) return "permission_missing";
  if (status === 404) return "not_found";
  if (status === 408 || status === 504 || status === 524) return "timeout";
  return "server_error";
}

export interface BasilFetchOptions extends RequestInit {
  /** Component name used in console error logs for easier debugging. */
  component?: string;
}

export async function basilFetch<T>(
  url: string,
  options?: BasilFetchOptions,
): Promise<T> {
  const { component = "unknown", ...fetchOptions } = options ?? {};

  // ── Network layer ──────────────────────────────────────────────────────────
  let res: Response;
  try {
    res = await fetch(url, fetchOptions);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const err = new BasilFetchError(
      "network_error",
      `Network error fetching ${url}: ${msg}`,
    );
    console.error("[basil-fetch] network_error", {
      route: url,
      component,
      error: msg,
    });
    throw err;
  }

  // ── HTTP error layer ───────────────────────────────────────────────────────
  if (!res.ok) {
    let serverMessage: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      serverMessage = body.error ?? body.message;
    } catch {
      // JSON parse failed — no server message, that's fine
    }

    const kind = kindFromStatus(res.status);
    const err = new BasilFetchError(
      kind,
      serverMessage ?? `HTTP ${res.status} from ${url}`,
      res.status,
      serverMessage,
    );
    console.error("[basil-fetch]", kind, {
      route: url,
      status: res.status,
      component,
      serverMessage,
    });
    throw err;
  }

  // ── JSON parse layer ───────────────────────────────────────────────────────
  try {
    return (await res.json()) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const err = new BasilFetchError(
      "server_error",
      `Failed to parse JSON from ${url}: ${msg}`,
      res.status,
    );
    console.error("[basil-fetch] json_parse_error", {
      route: url,
      status: res.status,
      component,
      error: msg,
    });
    throw err;
  }
}

/**
 * isBailableError — returns true for errors that represent a data-fetch
 * failure worth showing to the user (as opposed to an AbortError which
 * should be silently ignored).
 */
export function isBailableError(e: unknown): e is BasilFetchError | Error {
  if (e instanceof Error && e.name === "AbortError") return false;
  return e instanceof Error;
}
