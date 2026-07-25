import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for secrets / static tokens.
 *
 * A plain `a !== b` short-circuits on the first differing byte, leaking a timing
 * oracle that lets an attacker recover a secret byte-by-byte. Use this for every
 * admin-token / shared-secret check. Returns false on length mismatch (which is
 * itself non-secret) without comparing contents.
 */
export function timingSafeEqualStr(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = Buffer.from(a ?? "", "utf8");
  const right = Buffer.from(b ?? "", "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
