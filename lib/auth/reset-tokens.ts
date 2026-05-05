/**
 * Password-reset token store.
 *
 * Tokens are short-lived (15 min), one-time-use, and stored per user.
 * The store is a simple JSON file — lightweight enough for the expected
 * reset frequency (rare, one user at a time).
 */

import { readStore, writeStore } from "@/lib/storage/persistent";
import { randomBytes } from "node:crypto";

const TOKENS_FILE  = "password-reset-tokens.json";
const TTL_MS       = 15 * 60 * 1000; // 15 minutes

interface ResetToken {
  token:     string;
  username:  string;
  email:     string;
  expiresAt: string; // ISO
  used:      boolean;
}

async function readTokens(): Promise<ResetToken[]> {
  return readStore<ResetToken[]>(TOKENS_FILE, []);
}

async function writeTokens(tokens: ResetToken[]): Promise<void> {
  await writeStore(TOKENS_FILE, tokens, undefined, { durability: "strong" });
}

/** Purge expired or used tokens to keep the file small. */
async function gc(): Promise<void> {
  const now = Date.now();
  const tokens = await readTokens();
  const clean = tokens.filter(
    (t) => !t.used && new Date(t.expiresAt).getTime() > now
  );
  if (clean.length !== tokens.length) await writeTokens(clean);
}

/**
 * Create a reset token for the given user.
 * Any previous tokens for this user are invalidated.
 */
export async function createResetToken(username: string, email: string): Promise<string> {
  await gc();
  const tokens = await readTokens();

  // Invalidate any existing tokens for this user
  const others = tokens.filter(
    (t) => t.username.toLowerCase() !== username.toLowerCase()
  );

  const token = randomBytes(32).toString("hex");
  const entry: ResetToken = {
    token,
    username,
    email,
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
    used: false,
  };

  await writeTokens([...others, entry]);
  return token;
}

/**
 * Validate a reset token.
 * Returns the username if valid, null if expired/used/not found.
 * Does NOT mark the token as used — call consumeResetToken() after
 * the password has been successfully changed.
 */
export async function validateResetToken(token: string): Promise<string | null> {
  const tokens = await readTokens();
  const entry = tokens.find((t) => t.token === token);
  if (!entry || entry.used) return null;
  if (new Date(entry.expiresAt).getTime() < Date.now()) return null;
  return entry.username;
}

/**
 * Consume (mark as used) a reset token after a successful password change.
 */
export async function consumeResetToken(token: string): Promise<void> {
  const tokens = await readTokens();
  const idx = tokens.findIndex((t) => t.token === token);
  if (idx !== -1) {
    tokens[idx] = { ...tokens[idx], used: true };
    await writeTokens(tokens);
  }
}
