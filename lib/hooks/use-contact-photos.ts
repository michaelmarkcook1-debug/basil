"use client";

import { useState, useEffect, useRef } from "react";

// Module-level cache so photos are fetched at most once per browser session,
// shared across all components that call this hook.
const photoCache = new Map<string, string | null>();

/**
 * Batch-fetches Gravatar URLs for a list of email addresses.
 * Returns a map of { lowerCasedEmail → photoUrl }.
 * Already-cached emails are served from the in-memory cache without a network call.
 * A `null` value means the email has been looked up and has no photo.
 */
export function useContactPhotos(emails: string[]): Record<string, string> {
  // Stable, deduplicated list of emails that aren't in cache yet
  const uniqueEmails = Array.from(new Set(emails.map((e) => e.toLowerCase()).filter(Boolean)));
  const pending = uniqueEmails.filter((e) => !photoCache.has(e));

  // Initialise from cache so we don't start with an empty object on re-renders
  const initFromCache = () => {
    const map: Record<string, string> = {};
    for (const e of uniqueEmails) {
      const cached = photoCache.get(e);
      if (cached) map[e] = cached;
    }
    return map;
  };

  const [photos, setPhotos] = useState<Record<string, string>>(initFromCache);

  // Stable key — only re-run when the set of pending emails changes
  const pendingKey = pending.sort().join(",");
  const prevPendingKey = useRef("");

  useEffect(() => {
    if (!pending.length || pendingKey === prevPendingKey.current) return;
    prevPendingKey.current = pendingKey;

    const qs = encodeURIComponent(pending.join(","));
    fetch(`/api/contacts/photos?emails=${qs}`)
      .then((r) => r.json())
      .then((data: { photos?: Record<string, string> }) => {
        const incoming = data.photos ?? {};
        // Populate cache and merge into local state
        for (const e of pending) {
          photoCache.set(e, incoming[e] ?? null);
        }
        setPhotos((prev) => ({ ...prev, ...incoming }));
      })
      .catch(() => {
        // On error, cache as null so we don't retry on every render
        for (const e of pending) photoCache.set(e, null);
      });
  }, [pendingKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return photos;
}
