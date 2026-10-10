"use client";

/**
 * One client cache for opened emails, shared by every place an email opens
 * (Today cards, the watchlist, Threads, the reply dialog). The home page
 * preloads its emails into it, so opening one renders immediately.
 */
import useSWR, { preload } from "swr";

export interface Address { name: string; email: string }
export interface EmailView {
  id: string;
  subject: string;
  date: string;
  from: Address;
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  replyAllCc: Address[];
  body: string;
}

export const emailKey = (messageId: string) => `/api/email/${encodeURIComponent(messageId)}/reply`;

async function fetchEmail(url: string): Promise<EmailView> {
  const r = await fetch(url, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || "Could not open that email.");
  return j as EmailView;
}

/** Gmail message id from a feed/priority id ("gmail:<id>"), else null. */
export function gmailIdOf(id: string | undefined): string | null {
  return id?.startsWith("gmail:") ? id.slice("gmail:".length) || null : null;
}

export function useEmail(messageId: string) {
  return useSWR<EmailView>(emailKey(messageId), fetchEmail, { revalidateOnFocus: false, dedupingInterval: 5 * 60_000 });
}

/** Start loading these emails now so they open instantly later. */
export function preloadEmails(messageIds: string[]): void {
  for (const id of messageIds) void preload(emailKey(id), fetchEmail).catch(() => undefined);
}

export const showAddress = (a: Address) => (a.name ? `${a.name} <${a.email}>` : a.email);
export const showAddresses = (list: Address[]) => list.map(showAddress).join(", ");
