import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { findByEmail, findByUsername, createUser } from "@/lib/users";
import { patchSettings } from "@/lib/settings/store";
import { checkRateLimitDurable, getClientIp } from "@/lib/rate-limit";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

export async function POST(req: Request) {
  // Rate limit by IP — 10 attempts per minute, enforced across instances.
  const ip = getClientIp(req);
  const rl = await checkRateLimitDurable(`register:${ip}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many registration attempts — please wait ${rl.retryAfter} seconds.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  // Registration gate. Open self-registration lets any anonymous visitor create
  // an account that immediately draws on per-user AI/storage budget — a real
  // cost/abuse vector for a single-owner "Executive OS". Default CLOSED in
  // production; set ALLOW_REGISTRATION=true to open it (or create users via the
  // admin surface). Non-production (local dev) stays open for convenience.
  const isProd = process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
  if (isProd && process.env.ALLOW_REGISTRATION !== "true") {
    return NextResponse.json(
      { error: "Self-registration is disabled. Ask an administrator for an account." },
      { status: 403 }
    );
  }

  let name: string, surname: string, country: string, email: string, username: string, password: string;
  try {
    ({ name, surname, country, email, username, password } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Validate all fields present
  if (!name || !surname || !country || !email || !username || !password) {
    return NextResponse.json({ error: "All fields are required" }, { status: 400 });
  }

  // Field length limits — prevent oversized payloads from hitting the DB
  if (name.length > 100 || surname.length > 100 || country.length > 100) {
    return NextResponse.json({ error: "Field too long" }, { status: 400 });
  }

  // Username: alphanumeric + underscores/hyphens only, 3–30 chars
  if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) {
    return NextResponse.json(
      { error: "Username must be 3–30 characters and contain only letters, numbers, _ or -" },
      { status: 400 }
    );
  }

  // Validate email format
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Please enter a valid email address" }, { status: 400 });
  }

  // Validate password length
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  // Check for duplicate email
  const emailTaken = await findByEmail(email);
  if (emailTaken) {
    return NextResponse.json(
      { error: "This email is already linked to another account" },
      { status: 409 }
    );
  }

  // Check for duplicate username
  const usernameTaken = await findByUsername(username);
  if (usernameTaken) {
    return NextResponse.json(
      { error: "This username is already taken — please choose another" },
      { status: 409 }
    );
  }

  // Create the user (password hashed inside createUser) and start a session
  await createUser({ name, surname, country, email, username, password, onboardingCompleted: false });
  await createSession(username);

  // Write the real full name to the settings store immediately so Basil uses
  // "Jane Smith" rather than the username-derived default ("Janesmith").
  await patchSettings(username, { name: `${name} ${surname}`.trim() });

  // Flush snapshot so new user account survives a cold start
  await forceFlushSnapshot();

  return NextResponse.json({ success: true, username, onboardingCompleted: false });
}
