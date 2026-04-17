import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// No auth required — personal app, single user
export async function proxy(request: NextRequest) {
  // Redirect /login to dashboard since auth is disabled
  if (request.nextUrl.pathname === "/login") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }
  return NextResponse.next();
}

export const proxyConfig = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
