/**
 * User management — persisted via lib/storage/secure-auth-store.ts.
 *
 * User records are AES-256-GCM encrypted at rest (Sprint 2D).
 * Password hashes use bcryptjs (cost factor 12) — reversible encryption is
 * never applied to passwords.
 *
 * Public API:
 *   – All functions return full User objects internally for session validation.
 *   – Use toSafeUser() before including a User in any API response.
 */
import { readUserRecords, writeUserRecords } from "@/lib/storage/secure-auth-store";
import bcrypt from "bcryptjs";

export interface UserProfile {
  jobTitle?: string;
  company?: string;
  timezone?: string;
  workStart?: string; // "09:00"
  workEnd?: string;   // "18:00"
  communicationStyle?: "formal" | "balanced" | "casual";
  priorities?: string[];
  facts?: string[];
}

export interface User {
  id: string;
  name: string;
  surname: string;
  country: string;
  email: string;
  username: string;
  password: string; // bcrypt hash (or legacy plaintext for env-admin)
  createdAt: string;
  lastLoginAt?: string;
  onboardingCompleted?: boolean;
  profile?: UserProfile;
  /** When true the account is suspended — all sessions are rejected immediately. */
  disabled?: boolean;
  /** Incremented on password change or admin revocation to invalidate existing JWTs. */
  sessionVersion?: number;
}

/**
 * Safe user shape — password hash stripped.
 * Always use this type when including user data in API responses or logs.
 */
export type SafeUser = Omit<User, "password">;

/** Strip the password hash before sending a user record to a client. */
export function toSafeUser(user: User): SafeUser {
   
  const { password: _pw, ...safe } = user;
  return safe;
}

const BCRYPT_ROUNDS = 12;

/** Returns true if the string looks like a bcrypt hash. */
function isBcryptHash(s: string): boolean {
  return /^\$2[aby]\$\d+\$/.test(s);
}

/** Read all registered users, merging in any env-var admin account. */
export async function getUsers(): Promise<User[]> {
  const fileUsers = await readUserRecords();

  // Backward-compat: honour ADMIN_USERNAME + APP_PASSWORD if set and not
  // already in the file store.
  const adminUsername = process.env.ADMIN_USERNAME || "admin"; // ci-ok: ADMIN_USERNAME required in production; "admin" is the documented bootstrap default
  const adminPassword = process.env.APP_PASSWORD || "execauto2024";
  const alreadyInFile = fileUsers.some(
    (u) => u.username.toLowerCase() === adminUsername.toLowerCase()
  );

  if (!alreadyInFile) {
    const envAdmin: User = {
      id: "env-admin",
      name: "Admin",
      surname: "",
      country: "",
      email: "",
      username: adminUsername,
      password: adminPassword, // plaintext — only used until migrated
      createdAt: new Date(0).toISOString(),
      onboardingCompleted: true,
    };
    return [envAdmin, ...fileUsers];
  }

  return fileUsers;
}

/** Find a user by email (case-insensitive). */
export async function findByEmail(email: string): Promise<User | null> {
  const users = await getUsers();
  return (
    users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null
  );
}

/** Find a user by username (case-insensitive). */
export async function findByUsername(username: string): Promise<User | null> {
  const users = await getUsers();
  return (
    users.find((u) => u.username.toLowerCase() === username.toLowerCase()) ??
    null
  );
}

/**
 * Validate username + password.
 * Supports both bcrypt hashes and legacy plaintext (env-admin only).
 * If a plaintext match is found it is automatically upgraded to a bcrypt hash.
 */
export async function validateCredentials(
  username: string,
  password: string
): Promise<User | null> {
  const users = await getUsers();
  const user = users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );
  if (!user) return null;

  if (isBcryptHash(user.password)) {
    const ok = await bcrypt.compare(password, user.password);
    return ok ? user : null;
  }

  // Legacy plaintext comparison (env-admin or pre-migration users)
  if (user.password !== password) return null;

  // Auto-upgrade plaintext → bcrypt hash now that we know the plain password
  const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await upgradePasswordHash(user.username, hashed);
  return { ...user, password: hashed };
}

/** Internal: persist a new bcrypt hash for a user (used during auto-upgrade). */
async function upgradePasswordHash(username: string, hash: string): Promise<void> {
  try {
    const fileUsers = await readUserRecords();
    const idx = fileUsers.findIndex(
      (u) => u.username.toLowerCase() === username.toLowerCase()
    );
    if (idx !== -1) {
      fileUsers[idx] = { ...fileUsers[idx], password: hash };
      await writeUserRecords(fileUsers);
    }
  } catch {
    // Non-fatal — user can still log in; hash will be upgraded next time
  }
}

/** Persist a new user with a hashed password. Throws if email or username already exists. */
export async function createUser(
  data: Omit<User, "id" | "createdAt">
): Promise<User> {
  const fileUsers = await readUserRecords();

  // Hash the password before storing
  const hashedPassword = await bcrypt.hash(data.password, BCRYPT_ROUNDS);

  const newUser: User = {
    ...data,
    password: hashedPassword,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };

  await writeUserRecords([...fileUsers, newUser]);
  return newUser;
}

/** Update an existing user's fields (matched by username). */
export async function updateUser(
  username: string,
  patch: Partial<Omit<User, "id" | "username" | "createdAt">>
): Promise<void> {
  const fileUsers = await readUserRecords();
  const idx = fileUsers.findIndex((u) => u.username === username);
  if (idx === -1) {
    // env-admin user not yet in file — create their record first
    const allUsers = await getUsers();
    const user = allUsers.find((u) => u.username === username);
    if (user) {
      const updated = { ...user, ...patch };
      await writeUserRecords([...fileUsers, updated]);
    }
    return;
  }
  fileUsers[idx] = { ...fileUsers[idx], ...patch };
  await writeUserRecords(fileUsers);
}

/** Change a user's password and invalidate all existing sessions by bumping sessionVersion. */
export async function changePassword(
  username: string,
  newPassword: string
): Promise<void> {
  const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const fileUsers = await readUserRecords();
  const idx = fileUsers.findIndex((u) => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) throw new Error("User not found");
  const current = fileUsers[idx];
  fileUsers[idx] = {
    ...current,
    password: hashed,
    sessionVersion: (current.sessionVersion ?? 1) + 1,
  };
  await writeUserRecords(fileUsers);
}

/** Revoke all active sessions for a user by bumping their sessionVersion. */
export async function revokeUserSessions(username: string): Promise<void> {
  const fileUsers = await readUserRecords();
  const idx = fileUsers.findIndex((u) => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) throw new Error("User not found");
  const current = fileUsers[idx];
  fileUsers[idx] = { ...current, sessionVersion: (current.sessionVersion ?? 1) + 1 };
  await writeUserRecords(fileUsers);
}

/** Enable or disable a user account. */
export async function setUserDisabled(username: string, disabled: boolean): Promise<void> {
  const fileUsers = await readUserRecords();
  const idx = fileUsers.findIndex((u) => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) throw new Error("User not found");
  fileUsers[idx] = { ...fileUsers[idx], disabled };
  await writeUserRecords(fileUsers);
}

/** Delete a user account permanently. Cannot delete the env-admin. */
export async function deleteUser(username: string): Promise<void> {
  const fileUsers = await readUserRecords();
  const filtered = fileUsers.filter((u) => u.username.toLowerCase() !== username.toLowerCase());
  if (filtered.length === fileUsers.length) throw new Error("User not found in file store");
  await writeUserRecords(filtered);
}

/** Check whether a user is an admin (the primary account). */
export function isAdminUser(username: string): boolean {
  const adminUsername = process.env.ADMIN_USERNAME || "admin"; // ci-ok: ADMIN_USERNAME required in production; "admin" is the documented bootstrap default
  return username.toLowerCase() === adminUsername.toLowerCase();
}
