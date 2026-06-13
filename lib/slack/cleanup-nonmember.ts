/**
 * lib/slack/cleanup-nonmember.ts
 *
 * One-time cleanup: remove already-stored Slack-originated items that came from
 * channels the user is NOT a member of. The ingestion fix (is_member filter in
 * client.ts + the shouldClassifySlack gate) stops NEW leakage; this purges what
 * was stored before that fix existed.
 *
 * SAFETY CONTRACT (never delete legitimate data):
 *   - Membership is resolved live from Slack. If it can't be resolved (error,
 *     rate-limit, or zero channels) the whole run ABORTS and deletes nothing.
 *   - An item is removed ONLY when it has ≥1 parseable Slack channel ref AND
 *     EVERY parseable Slack channel ref resolves to a non-member channel.
 *   - An item with no parseable Slack channel ref (e.g. a display-name middle
 *     segment, or no slack: ref at all) is KEPT — we can't prove irrelevance.
 *   - Identity is per-user from the Slack auth token — no hardcoded user.
 *
 * Channel-id recoverability (the basis for what can be cleaned):
 *   Actions / Decisions / Memory / SignalEvents store `slack:<channelId>:<ts>`
 *   in sourceRef / externalId → safe. SignalThreads carry NO channel id, so they
 *   are only pruned by reconciliation against the removed SignalEvent ids.
 */

import "server-only";
import { getSlackBotClientForUser, getSlackUserClientForUser, getSlackConfig } from "@/lib/slack/client";
import { listActions, deleteAction } from "@/lib/actions/store";
import { listDecisions, deleteDecision } from "@/lib/decisions/store";
import { listMemories, deleteMemory } from "@/lib/memory/store";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import type { SignalEvent } from "@/core/primitives/signal-event";
import type { SignalThread } from "@/core/primitives/signal-thread";

const SIGNAL_EVENTS_FILE = "sage-signal-events.json";
const SIGNAL_THREADS_FILE = "sage-signal-threads.json";

// A real Slack conversation id: C… (channel), G… (private/group), D… (DM).
const SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/i;

/** Extract a real Slack channel id from a `slack:<channelId>:<ts>` ref, or null. */
export function parseSlackChannelId(ref: string | undefined | null): string | null {
  if (!ref) return null;
  const parts = ref.split(":");
  if (parts[0] !== "slack" || parts.length < 3) return null;
  const id = parts[1];
  return SLACK_CHANNEL_ID.test(id) ? id : null;
}

/**
 * Verdict for an item given its Slack refs and the user's member-channel set.
 * "keep" unless we can PROVE every parseable channel ref is non-member.
 */
export function slackRefsVerdict(
  refs: (string | undefined | null)[],
  memberIds: Set<string>
): "delete" | "keep" {
  const channelIds = refs.map(parseSlackChannelId).filter((x): x is string => x !== null);
  if (channelIds.length === 0) return "keep"; // can't prove → keep
  if (channelIds.some((id) => memberIds.has(id))) return "keep"; // any member ref → keep
  return "delete"; // ≥1 parseable id, none of them a member channel
}

export type MemberChannels =
  | { ok: true; ids: Set<string>; selfUserId?: string }
  | { ok: false };

/**
 * The user's current member channel ids (joined public/private channels + all
 * DMs and Group DMs), paginated exhaustively. Fail-closed: returns { ok:false }
 * on any error, rate-limit, or an empty result so the caller aborts rather than
 * treating "couldn't resolve" as "member of nothing".
 */
export async function getMemberChannelIds(username: string): Promise<MemberChannels> {
  const [botWeb, userWeb] = await Promise.all([
    getSlackBotClientForUser(username),
    getSlackUserClientForUser(username),
  ]);
  const web = userWeb || botWeb;
  if (!web) return { ok: false };

  const ids = new Set<string>();
  try {
    // Joined public/private channels.
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await web.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const c of res.channels || []) {
        if (c.id && c.is_member === true) ids.add(c.id);
      }
      cursor = res.response_metadata?.next_cursor || undefined;
      pages++;
    } while (cursor && pages < 25);

    // DMs (im) and Group DMs (mpim) — inherently the user's.
    for (const type of ["im", "mpim"] as const) {
      let c2: string | undefined;
      let p2 = 0;
      do {
        const res = await web.conversations.list({ types: type, limit: 200, cursor: c2 });
        for (const c of res.channels || []) if (c.id) ids.add(c.id);
        c2 = res.response_metadata?.next_cursor || undefined;
        p2++;
      } while (c2 && p2 < 15);
    }
  } catch {
    return { ok: false }; // fail-closed
  }

  // Empty → treat as "couldn't resolve", not "in zero channels".
  if (ids.size === 0) return { ok: false };

  const config = await getSlackConfig(username);
  let selfUserId = config.authUserId;
  if (!selfUserId) {
    try {
      selfUserId = (await web.auth.test()).user_id as string | undefined;
    } catch {
      /* mention detection is optional; channel membership is the authoritative signal */
    }
  }
  return { ok: true, ids, selfUserId };
}

export interface CleanupReport {
  aborted: boolean;
  dryRun: boolean;
  memberChannelCount: number;
  deletedActions: number;
  deletedDecisions: number;
  deletedMemories: number;
  deletedSignalEvents: number;
  prunedThreads: number;
  keptUnprovable: number;
  removed: string[]; // capped sample for review
}

function emptyReport(dryRun: boolean): CleanupReport {
  return {
    aborted: true,
    dryRun,
    memberChannelCount: 0,
    deletedActions: 0,
    deletedDecisions: 0,
    deletedMemories: 0,
    deletedSignalEvents: 0,
    prunedThreads: 0,
    keptUnprovable: 0,
    removed: [],
  };
}

const SAMPLE_CAP = 60;

/**
 * Purge stored Slack items from non-member channels. Dry-run reports what would
 * be removed without mutating anything.
 */
export async function purgeNonMemberSlackItems(
  username: string,
  opts: { dryRun?: boolean } = {}
): Promise<CleanupReport> {
  const dryRun = opts.dryRun ?? false;

  const member = await getMemberChannelIds(username);
  if (!member.ok) return emptyReport(dryRun); // fail-closed → aborted:true

  const report = emptyReport(dryRun);
  report.aborted = false;
  report.memberChannelCount = member.ids.size;
  const sample = (s: string) => {
    if (report.removed.length < SAMPLE_CAP) report.removed.push(s);
  };

  // ── Actions ────────────────────────────────────────────────────────────────
  const actions = await listActions(username, { fresh: true });
  for (const a of actions) {
    if (a.source !== "slack") continue;
    if (slackRefsVerdict([a.sourceRef, ...(a.additionalSourceRefs ?? [])], member.ids) === "keep") {
      report.keptUnprovable++;
      continue;
    }
    sample(`action: ${(a.text ?? "").slice(0, 70)}`);
    if (dryRun) report.deletedActions++;
    else { try { if (await deleteAction(username, a.id)) report.deletedActions++; } catch { /* skip */ } }
  }

  // ── Decisions ────────────────────────────────────────────────────────────────
  const decisions = await listDecisions(username);
  for (const d of decisions) {
    if (d.source !== "slack") continue;
    if (slackRefsVerdict([d.sourceRef, ...(d.additionalSourceRefs ?? [])], member.ids) === "keep") {
      report.keptUnprovable++;
      continue;
    }
    sample(`decision: ${(d.text ?? "").slice(0, 70)}`);
    if (dryRun) report.deletedDecisions++;
    else { try { if (await deleteDecision(username, d.id)) report.deletedDecisions++; } catch { /* skip */ } }
  }

  // ── Memory (filter by sourceRef prefix — materialize sets source:"inferred") ──
  const memories = await listMemories(username);
  for (const m of memories) {
    if (!m.sourceRef?.startsWith("slack:")) continue;
    if (slackRefsVerdict([m.sourceRef], member.ids) === "keep") {
      report.keptUnprovable++;
      continue;
    }
    sample(`memory: ${(m.content ?? "").slice(0, 70)}`);
    if (dryRun) report.deletedMemories++;
    else { try { if (await deleteMemory(username, m.id)) report.deletedMemories++; } catch { /* skip */ } }
  }

  // ── Signal events + thread reconciliation ────────────────────────────────────
  const events = await readUserStore<SignalEvent[]>(username, SIGNAL_EVENTS_FILE, []);
  if (events.length > 0) {
    const doomed = new Set<string>();
    for (const ev of events) {
      if (ev.source === "slack" && slackRefsVerdict([ev.externalId, ev.sourceRef], member.ids) === "delete") {
        doomed.add(ev.id);
        sample(`signal: ${(ev.title ?? ev.externalId).slice(0, 70)}`);
      }
    }
    report.deletedSignalEvents = doomed.size;

    if (doomed.size > 0) {
      // Count threads that lose ≥1 signal (drop when all gone, prune when some).
      const threadMap = await readUserStore<Record<string, SignalThread>>(username, SIGNAL_THREADS_FILE, {});
      for (const t of Object.values(threadMap)) {
        const keptIds = (t.signalIds ?? []).filter((id) => !doomed.has(id));
        if (keptIds.length !== (t.signalIds ?? []).length) report.prunedThreads++;
      }

      if (!dryRun) {
        // Atomic read-modify-write under a cross-instance lock (race-safe vs a
        // concurrent ingest). allowShrink bypasses the shrink tripwire for this
        // intentional bulk removal.
        await updateUserStore<SignalEvent[]>(
          username,
          SIGNAL_EVENTS_FILE,
          (cur) => cur.filter((ev) => !doomed.has(ev.id)),
          [],
          { allowShrink: true }
        );
        await updateUserStore<Record<string, SignalThread>>(
          username,
          SIGNAL_THREADS_FILE,
          (cur) => {
            const next: Record<string, SignalThread> = { ...cur };
            for (const [key, t] of Object.entries(next)) {
              const keptIds = (t.signalIds ?? []).filter((id) => !doomed.has(id));
              if (keptIds.length === (t.signalIds ?? []).length) continue;
              if (keptIds.length === 0) delete next[key];
              else next[key] = { ...t, signalIds: keptIds, signalCount: keptIds.length };
            }
            return next;
          },
          {},
          { allowShrink: true }
        );
      }
    }
  }

  return report;
}
