import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const COOKIE_NAME = "execauto_session";

// Routes that don't require a session
const PUBLIC_PATHS = new Set(["/login", "/register", "/privacy", "/terms", "/reset-password"]);
// API prefixes that don't require a session (OAuth callbacks must work unauthenticated)
const PUBLIC_API_PREFIXES = [
  "/api/auth",           // login, logout
  "/api/auth/google",    // Google OAuth callback
  "/api/auth/microsoft", // Microsoft OAuth callback
  "/api/webhooks",       // Inbound webhooks (signed by provider, not session-authed)
  "/api/health",         // Liveness check — must be reachable without a session for CI and uptime monitors
];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p));
}

async function isAuthenticated(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return false;
  try {
    const secret = new TextEncoder().encode(
      process.env.AUTH_SECRET || "dev-secret-change-me"
    );
    await jwtVerify(token, secret);
    return true;
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Dev bypass — SKIP_AUTH=true lets all requests through without a session.
  if (process.env.SKIP_AUTH === "true") {
    return NextResponse.next();
  }

  // Always pass static assets and Next.js internals through — never auth-gate them.
  // The proxyConfig matcher should already exclude these, but we guard here too
  // because the matcher regex may not be applied in all Next.js 16 edge cases.
  if (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    /\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf)$/.test(pathname)
  ) {
    return NextResponse.next();
  }

  // Always allow public routes through immediately.
  // NOTE: We intentionally do NOT redirect authenticated users away from /login.
  // Doing so would create an infinite loop when the session JWT is signature-valid
  // but the sessionVersion is stale (e.g. after a password reset): DashboardLayout
  // gets a 401 from /api/settings and sends the user to /login, then this proxy
  // would see a valid JWT and send them back to /dashboard, and so on forever.
  // The full sessionVersion check only happens inside API route handlers.
  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  // For all other routes, require a valid session
  if (!(await isAuthenticated(request))) {
    // API routes → 401 JSON (client can handle gracefully)
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // UI routes → redirect to login
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const proxyConfig = {
  runtime: "nodejs",
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
