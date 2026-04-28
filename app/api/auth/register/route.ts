import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { findByEmail, findByUsername, createUser } from "@/lib/users";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export async function POST(req: Request) {
  // Rate limit by IP — 10 attempts per minute
  const ip = getClientIp(req);
  const rl = checkRateLimit(`register:${ip}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many registration attempts — please wait ${rl.retryAfter} seconds.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  const { name, surname, country, email, username, password } = await req.json();

  // Validate all fields present
  if (!name || !surname || !country || !email || !username || !password) {
    return NextResponse.json({ error: "All fields are required" }, { status: 400 });
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

  return NextResponse.json({ success: true, username, onboardingCompleted: false });
}
