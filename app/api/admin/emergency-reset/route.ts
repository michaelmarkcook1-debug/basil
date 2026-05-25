/**
 * POST /api/admin/emergency-reset
 *
 * Emergency password reset / account recovery endpoint.
 * Protected by ADMIN_API_TOKEN — no session required.
 *
 * Use when the normal forgot-password flow cannot find the account
 * (e.g., encryption key mismatch, env-admin only, Blob read failure).
 *
 * Body: { username: string; newPassword: string; email?: string; name?: string }
 *
 * Behaviour:
 *  1. If a file-persisted user with this username exists → change their password.
 *  2. If not found in file store (env-admin case or decryption failed) →
 *     upsert a new file-persisted record with the given credentials so that
 *     normal login works going forward.
 *
 * The write falls back to plaintext users.json if BASIL_TOKEN_ENCRYPTION_KEY
 * is missing, so this works even when encryption is broken.
 */

import { NextResponse } from "next/server";
import { readUserRecords, writeUserRecords } from "@/lib/storage/secure-auth-store";
import { getUsers } from "@/lib/users";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "ADMIN_API_TOKEN is not set on this deployment." },
      { status: 503 }
    );
  }

  const authHeader = req.headers.get("x-admin-token") ?? "";
  if (authHeader !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let username: string, newPassword: string, email: string, name: string;
  try {
    const body = await req.json();
    username    = typeof body.username    === "string" ? body.username.trim().toLowerCase()    : "";
    newPassword = typeof body.newPassword === "string" ? body.newPassword                      : "";
    email       = typeof body.email       === "string" ? body.email.trim().toLowerCase()       : "";
    name        = typeof body.name        === "string" ? body.name.trim()                      : username;
    if (!username || !newPassword) throw new Error("missing");
  } catch {
    return NextResponse.json(
      { error: "Body must include username (string) and newPassword (string)." },
      { status: 400 }
    );
  }

  if (newPassword.length < 8) {
    return NextResponse.json(
      { error: "newPassword must be at least 8 characters." },
      { status: 400 }
    );
  }

  // ── Hash the new password ───────────────────────────────────────────────────
  const hashed = await bcrypt.hash(newPassword, 12);

  // ── Read current file users (may be empty if decryption broke) ─────────────
  let fileUsers = await readUserRecords();
  const idx = fileUsers.findIndex(
    (u) => u.username.toLowerCase() === username
  );

  if (idx !== -1) {
    // ── Case 1: user exists in file store — update password ──────────────────
    fileUsers[idx] = {
      ...fileUsers[idx],
      password: hashed,
      ...(email && { email }),
      sessionVersion: (fileUsers[idx].sessionVersion ?? 1) + 1,
    };
    await writeUserRecords(fileUsers);
    await forceFlushSnapshot();
    return NextResponse.json({
      ok: true,
      action: "updated",
      username: fileUsers[idx].username,
    });
  }

  // ── Case 2: not in file store (env-admin or decryption failed) ──────────────
  // Grab whatever data exists in the virtual user list (includes env-admin)
  const allUsers = await getUsers();
  const existing = allUsers.find(
    (u) => u.username.toLowerCase() === username
  );

  const upserted = {
    id:                   existing?.id ?? crypto.randomUUID(),
    name:                 existing?.name ?? name,
    surname:              existing?.surname ?? "",
    country:              existing?.country ?? "",
    email:                existing?.email ?? email,
    username:             existing?.username ?? username,
    password:             hashed,
    createdAt:            existing?.createdAt ?? new Date().toISOString(),
    onboardingCompleted:  existing?.onboardingCompleted ?? true,
    sessionVersion:       (existing?.sessionVersion ?? 1) + 1,
  };

  // Persist alongside any other file users (preserves any still-valid records)
  await writeUserRecords([...fileUsers, upserted]);
  await forceFlushSnapshot();

  return NextResponse.json({
    ok: true,
    action: existing ? "migrated-from-env-admin" : "created",
    username: upserted.username,
  });
}
