import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const COOKIE_NAME = "execauto_session";

// Routes that don't require a session
const PUBLIC_PATHS = new Set(["/login", "/register"]);
// API prefixes that don't require a session (OAuth callbacks must work unauthenticated)
const PUBLIC_API_PREFIXES = [
  "/api/auth",           // login, logout
  "/api/auth/google",    // Google OAuth callback
  "/api/auth/microsoft", // Microsoft OAuth callback
  "/api/webhooks",       // Inbound webhooks (signed by provider, not session-authed)
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

  // Always allow public routes through immediately
  if (isPublic(pathname)) {
    // Redirect authenticated users away from /login to avoid double-login
    if (pathname === "/login" && (await isAuthenticated(request))) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
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
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
