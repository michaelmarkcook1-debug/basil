import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";


/**
 * Route protection middleware.
 *
 * Protects /dashboard/* and /onboarding routes — redirects unauthenticated
 * visitors to /login with a ?return= param so they land back where they
 * started after signing in.
 *
 * Uses JWT-only validation (no user-store lookup) so it works in any
 * environment regardless of whether BASIL_TOKEN_ENCRYPTION_KEY is set.
 * Full session validation (including sessionVersion and disabled check)
 * is done in individual API routes and server components.
 */

const COOKIE_NAME = "execauto_session";

// Paths that require a valid session JWT
const PROTECTED_PREFIXES = ["/dashboard", "/onboarding"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );

  // Only intercept protected routes — do NOT redirect authenticated users away
  // from /login. The dashboard layout has its own 401-handler that calls
  // window.location.replace("/login"); if we then bounce them back to /dashboard
  // we get an infinite redirect loop when the session is valid as a JWT but
  // stale in the user store (e.g. after a password change or session version bump).
  if (!isProtected) return NextResponse.next();

  // ── Validate session JWT ────────────────────────────────────────────────────
  const token = req.cookies.get(COOKIE_NAME)?.value;
  let authenticated = false;

  if (token) {
    try {
      const rawSecret = process.env.AUTH_SECRET || "dev-secret-change-me";
      const secret    = new TextEncoder().encode(rawSecret);
      const { payload } = await jwtVerify(token, secret);
      authenticated = !!(payload.username && payload.authenticated);
    } catch {
      // Invalid / expired JWT — treat as unauthenticated
    }
  }

  // ── Redirect unauthenticated users to login ─────────────────────────────────
  if (!authenticated) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("return", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const proxyConfig = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     * - _next/static  (static files)
     * - _next/image   (image optimisation)
     * - favicon.ico, robots.txt, sitemap.xml, manifest.json
     * - /api/*        (API routes handle their own auth)
     * - Public assets (*.svg, *.png, *.jpg, *.ico, *.webp)
     */
    "/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|manifest\\.json|api/|.*\\.(?:svg|png|jpg|jpeg|ico|webp|woff2?|ttf|otf)).*)",
  ],
};
