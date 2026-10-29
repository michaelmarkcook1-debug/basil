/**
 * Where a user's uploaded originals live in Blob storage: basil/media/<user>/.
 * Outside basil/users/** on purpose — the nightly backup copies that tree, and
 * hundreds of MB of video copied every night would be cost without benefit.
 * Account deletion purges both (lib/storage/adapters/blob.ts).
 */
export function mediaPrefix(username: string): string {
  return `basil/media/${username.toLowerCase().replace(/[^a-zA-Z0-9._-]/g, "_")}/`;
}
