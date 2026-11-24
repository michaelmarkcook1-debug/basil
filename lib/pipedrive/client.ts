/**
 * lib/pipedrive/client.ts — Pipedrive CRM, read-only, with the user's personal
 * API token (Settings → Personal preferences → API in Pipedrive).
 *
 * Michael, 2026-11-24: "all Pipedrive content needs to feed into Basil
 * context". So Basil reads the whole account it can see, not just the user's
 * own open items:
 *   - deals in every status (open, won, lost) and every owner, with stage and pipeline;
 *   - activities: ALL of them, open and done, every owner, however old — with
 *     their notes (the meeting and call write-ups). "Ensure we are pulling all
 *     meeting notes and activities" (2026-11-24): no age filter;
 *   - people and organisations;
 *   - every note on deals, people, organisations and leads, in full;
 *   - leads; users (to name owners); stages and pipelines.
 *
 * One snapshot per user, shared by every Basil server through the user's
 * store, read in full ONCE A DAY (Michael, 2026-11-24: "once daily will be
 * fine") by /api/cron/pipedrive-sync before the morning briefing, on connect,
 * and when the user presses "Refresh now". Everything else — Today, Ask Basil,
 * the briefing, meeting prep, profiles — reads the stored copy and never calls
 * Pipedrive while the user waits. A failed refresh keeps the last good copy,
 * marked stale.
 *
 *   - The token is kept encrypted per user (secure-token-store "pipedrive"),
 *     never in env vars and never shared between Basil accounts.
 *   - Basil never writes to Pipedrive.
 */
import "server-only";
import { getIntegrationToken, saveIntegrationToken, deleteIntegrationToken } from "@/lib/storage/secure-token-store";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import {
  buildDirectory, domainFromWebsite, emailDomain,
  type CrmDirectory, type PdActivity, type PdDeal, type PdLead, type PdNote, type PdOrg, type PdPerson,
} from "@/lib/pipedrive/shape";

const V2 = "https://api.pipedrive.com/api/v2";
const V1 = "https://api.pipedrive.com/v1";
const TIMEOUT_MS = 15_000;
/** A stored copy older than this is refreshed on the next read (the daily cron was missed). */
const FRESH_MS = 26 * 60 * 60 * 1000;
/** In-memory copy, so one request does not re-read the store for every surface. */
const MEMORY_MS = 5 * 60 * 1000;
/** Pages of 500 per list: far beyond this account (3,000+ people), so lists are read whole. */
const MAX_PAGES = 60;
const SNAPSHOT_FILE = "pipedrive-snapshot.json";
/** Pages of 500 for the full-history reads (notes, done activities): up to 30,000 each. */
const HISTORY_PAGES = 60;
/** Longest note / meeting note kept, in characters. */
const NOTE_CHARS = 6_000;

export interface PipedriveConfig {
  apiToken?: string;
  userId?: number;
  userName?: string;
  userEmail?: string;
  companyName?: string;
  companyDomain?: string;
  connectedAt?: string;
}

export async function getPipedriveConfig(username: string): Promise<PipedriveConfig> {
  return (await getIntegrationToken<PipedriveConfig>(username, "pipedrive")) ?? {};
}

export async function isPipedriveConnected(username: string): Promise<boolean> {
  return !!(await getPipedriveConfig(username)).apiToken;
}

export async function deletePipedriveConfig(username: string): Promise<void> {
  memory.delete(username);
  await deleteIntegrationToken(username, "pipedrive");
  await writeUserStore(username, SNAPSHOT_FILE, null);
}

export class PipedriveError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

interface Page<T> { data: T; nextCursor?: string | null; nextStart?: number | null }

async function call<T>(token: string, url: string): Promise<Page<T>> {
  const res = await fetch(url, {
    headers: { "x-api-token": token, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 401) throw new PipedriveError("Pipedrive rejected the API token (401). Paste a current token in Settings.", 401);
  if (res.status === 429) throw new PipedriveError("Pipedrive's daily API budget is used up (429). It resets tomorrow.", 429);
  if (!res.ok) throw new PipedriveError(`Pipedrive ${res.status}`, res.status);
  const body = (await res.json()) as {
    success?: boolean; data?: T; error?: string;
    additional_data?: { next_cursor?: string | null; pagination?: { more_items_in_collection?: boolean; next_start?: number } };
  };
  if (body.success === false) throw new PipedriveError(body.error ?? "Pipedrive returned an error", res.status);
  const pg = body.additional_data?.pagination;
  return { data: body.data as T, nextCursor: body.additional_data?.next_cursor, nextStart: pg?.more_items_in_collection ? pg.next_start ?? null : null };
}

type Params = Record<string, string | number | boolean | undefined>;
const qs = (p: Params) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== "") q.set(k, String(v));
  return q.toString();
};

/** A list and whether it was read to the end (false = the page cap stopped it). */
export interface Listed<T> { items: T[]; complete: boolean }

/** A v2 list, following cursors. */
async function listV2<T>(token: string, path: string, params: Params, pages = MAX_PAGES): Promise<Listed<T>> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    const { data, nextCursor } = await call<T[] | null>(token, `${V2}${path}?${qs({ limit: 500, ...params, cursor })}`);
    items.push(...(data ?? []));
    if (!nextCursor) return { items, complete: true };
    cursor = nextCursor;
  }
  return { items, complete: false };
}

/** A v1 list, following start/limit pagination. */
async function listV1<T>(token: string, path: string, params: Params, pages = MAX_PAGES): Promise<Listed<T>> {
  const items: T[] = [];
  let start = 0;
  for (let i = 0; i < pages; i++) {
    const { data, nextStart } = await call<T[] | null>(token, `${V1}${path}?${qs({ limit: 500, ...params, start })}`);
    items.push(...(data ?? []));
    if (nextStart === null || nextStart === undefined) return { items, complete: true };
    start = nextStart;
  }
  return { items, complete: false };
}

/** Check a token and learn whose it is. Used when connecting, and by the admin check. */
export async function validatePipedriveToken(apiToken: string): Promise<Required<Omit<PipedriveConfig, "apiToken" | "connectedAt">>> {
  const { data } = await call<{ id: number; name: string; email: string; company_name: string; company_domain: string }>(apiToken, `${V1}/users/me`);
  if (!data?.id) throw new PipedriveError("Pipedrive did not say whose token this is.", 400);
  return { userId: data.id, userName: data.name, userEmail: data.email, companyName: data.company_name, companyDomain: data.company_domain };
}

export async function savePipedriveToken(username: string, apiToken: string): Promise<PipedriveConfig> {
  const who = await validatePipedriveToken(apiToken);
  const cfg: PipedriveConfig = { apiToken, ...who, connectedAt: new Date().toISOString() };
  await saveIntegrationToken(username, "pipedrive", cfg);
  memory.delete(username);
  await writeUserStore(username, SNAPSHOT_FILE, null);
  return cfg;
}

// ── Raw shapes (only the fields Basil reads) ─────────────────────────────────

interface RawActivity { id: number; subject: string; type: string; due_date: string | null; due_time: string | null; deal_id: number | null; lead_id?: string | null; person_id: number | null; org_id: number | null; note?: string | null; public_description?: string | null; update_time: string; done?: boolean; owner_id?: number | null; marked_as_done_time?: string | null }
interface RawDeal { id: number; title: string; value: number; currency: string; stage_id: number; pipeline_id?: number; status: string; person_id: number | null; org_id: number | null; expected_close_date: string | null; update_time: string; add_time?: string; stage_change_time: string | null; owner_id?: number | null; won_time?: string | null; lost_time?: string | null; lost_reason?: string | null; probability?: number | null }
interface RawPerson { id: number; name: string; emails?: { value: string }[] | null; phones?: { value: string }[] | null; org_id: number | null; job_title?: string | null }
interface RawOrg { id: number; name: string; website?: string | null; industry?: string | number | null }
interface RawStage { id: number; name: string; pipeline_id?: number }
interface RawPipeline { id: number; name: string }
interface RawNote { id: number; content?: string | null; deal_id?: number | null; person_id?: number | null; org_id?: number | null; lead_id?: string | null; user_id?: number | null; add_time: string; update_time: string; active_flag?: boolean }
interface RawLead { id: string; title: string; person_id?: number | null; organization_id?: number | null; owner_id?: number | null; value?: { amount: number; currency: string } | null; expected_close_date?: string | null; source_name?: string | null; add_time: string; update_time: string; is_archived?: boolean }
interface RawUser { id: number; name: string; active_flag?: boolean }

/** HTML notes → plain text. */
export function stripHtml(s?: string | null, max = 1_500): string {
  return (s ?? "")
    .replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, max);
}

// ── The snapshot ─────────────────────────────────────────────────────────────

/** What is persisted (Sets are rebuilt on read). */
interface StoredSnapshot {
  v: 2;
  at: number;
  userId: number | null;
  companyDomain?: string;
  activities: PdActivity[];
  deals: PdDeal[];
  persons: PdPerson[];
  orgs: PdOrg[];
  notes: PdNote[];
  leads: PdLead[];
  users: Record<string, string>;
  /** Per list: how many were read and whether it was read to the end. */
  coverage?: Record<string, { count: number; complete: boolean }>;
}

export interface PipedriveSnapshot extends StoredSnapshot {
  directory: CrmDirectory;
  /** True when this is the last good copy because a refresh failed. */
  stale?: boolean;
}

async function load(username: string, cfg: PipedriveConfig): Promise<StoredSnapshot> {
  const t = cfg.apiToken!;
  const [openL, doneL, dealsL, personsL, orgsL, stagesL, pipelinesL, notesL, leadsL, usersL] = await Promise.all([
    listV2<RawActivity>(t, "/activities", { done: false, sort_by: "due_date", sort_direction: "asc" }),
    listV2<RawActivity>(t, "/activities", { done: true, sort_by: "update_time", sort_direction: "desc" }, HISTORY_PAGES),
    listV2<RawDeal>(t, "/deals", { sort_by: "update_time", sort_direction: "desc" }),
    listV2<RawPerson>(t, "/persons", { sort_by: "update_time", sort_direction: "desc" }),
    listV2<RawOrg>(t, "/organizations", { sort_by: "update_time", sort_direction: "desc" }),
    listV2<RawStage>(t, "/stages", {}, 4),
    listV2<RawPipeline>(t, "/pipelines", {}, 2),
    listV1<RawNote>(t, "/notes", { sort: "update_time DESC" }, HISTORY_PAGES),
    listV1<RawLead>(t, "/leads", { sort: "update_time DESC" }, MAX_PAGES),
    listV1<RawUser>(t, "/users", {}, 2),
  ]);
  const [openActs, doneActs, rawDeals, rawPersons, rawOrgs, rawStages, rawPipelines, rawNotes, rawLeads, rawUsers] =
    [openL.items, doneL.items, dealsL.items, personsL.items, orgsL.items, stagesL.items, pipelinesL.items, notesL.items, leadsL.items, usersL.items] as const;
  const coverage = {
    openActivities: { count: openActs.length, complete: openL.complete },
    doneActivities: { count: doneActs.length, complete: doneL.complete },
    deals: { count: rawDeals.length, complete: dealsL.complete },
    people: { count: rawPersons.length, complete: personsL.complete },
    organisations: { count: rawOrgs.length, complete: orgsL.complete },
    notes: { count: rawNotes.length, complete: notesL.complete },
    leads: { count: rawLeads.length, complete: leadsL.complete },
  };
  const stageName = new Map(rawStages.map((s) => [s.id, s.name]));
  const pipelineName = new Map(rawPipelines.map((p) => [p.id, p.name]));
  const act = (a: RawActivity): PdActivity => ({
    id: a.id, subject: a.subject, type: a.type, dueDate: a.due_date, dueTime: a.due_time ? a.due_time.slice(0, 5) : null,
    dealId: a.deal_id ?? null, personId: a.person_id ?? null, orgId: a.org_id ?? null,
    ...(a.lead_id ? { leadId: a.lead_id } : {}),
    ...(a.note || a.public_description ? { note: stripHtml(a.note || a.public_description, NOTE_CHARS) } : {}),
    updateTime: a.update_time, ownerId: a.owner_id ?? null, done: !!a.done, doneTime: a.marked_as_done_time ?? null,
  });
  return {
    v: 2,
    at: Date.now(),
    userId: cfg.userId ?? null,
    companyDomain: cfg.companyDomain,
    activities: [
      ...openActs.filter((a) => !a.done).map(act),
      // Every done activity, however old, with its notes.
      ...doneActs.filter((a) => a.done).map(act),
    ],
    coverage,
    deals: rawDeals.map((d) => ({
      id: d.id, title: d.title, value: d.value ?? 0, currency: d.currency, stage: stageName.get(d.stage_id) ?? `Stage ${d.stage_id}`,
      status: d.status, personId: d.person_id ?? null, orgId: d.org_id ?? null, expectedClose: d.expected_close_date ?? null,
      updateTime: d.update_time, stageChangeTime: d.stage_change_time ?? null, ownerId: d.owner_id ?? null,
      ...(d.pipeline_id && pipelineName.get(d.pipeline_id) ? { pipeline: pipelineName.get(d.pipeline_id) } : {}),
      ...(d.add_time ? { addTime: d.add_time } : {}),
      wonTime: d.won_time ?? null, lostTime: d.lost_time ?? null, lostReason: d.lost_reason ?? null, probability: d.probability ?? null,
    })),
    persons: rawPersons.map((p) => ({
      id: p.id, name: p.name, orgId: p.org_id ?? null,
      emails: (p.emails ?? []).map((e) => e.value).filter(Boolean),
      ...(p.phones?.length ? { phones: p.phones.map((x) => x.value).filter(Boolean) } : {}),
      ...(p.job_title ? { jobTitle: p.job_title } : {}),
    })),
    orgs: rawOrgs.map((o) => ({
      id: o.id, name: o.name,
      ...(o.website ? { website: o.website, domain: domainFromWebsite(o.website) } : {}),
      ...(typeof o.industry === "string" && o.industry ? { industry: o.industry } : {}),
    })),
    notes: rawNotes.filter((n) => n.active_flag !== false && n.content).map((n) => ({
      id: n.id, content: stripHtml(n.content, NOTE_CHARS), dealId: n.deal_id ?? null, personId: n.person_id ?? null, orgId: n.org_id ?? null,
      leadId: n.lead_id ?? null, userId: n.user_id ?? null, addTime: n.add_time, updateTime: n.update_time,
    })),
    leads: rawLeads.map((l) => ({
      id: l.id, title: l.title, personId: l.person_id ?? null, orgId: l.organization_id ?? null, ownerId: l.owner_id ?? null,
      value: l.value ?? null, expectedClose: l.expected_close_date ?? null, source: l.source_name ?? null,
      addTime: l.add_time, updateTime: l.update_time, archived: !!l.is_archived,
    })),
    users: Object.fromEntries(rawUsers.map((u) => [String(u.id), u.name])),
  };
}

function withDirectory(s: StoredSnapshot, ownDomains: readonly string[], cfg: PipedriveConfig, stale = false): PipedriveSnapshot {
  const own = [...ownDomains, ...(cfg.userEmail ? [emailDomain(cfg.userEmail) ?? ""] : [])].filter(Boolean);
  return { ...s, directory: buildDirectory(s.persons, s.orgs, own), ...(stale ? { stale } : {}) };
}

const memory = new Map<string, { snap: PipedriveSnapshot; readAt: number }>();
const inflight = new Map<string, Promise<PipedriveSnapshot | null>>();

async function readStored(username: string, cfg: PipedriveConfig): Promise<StoredSnapshot | null> {
  const stored = await readUserStore<StoredSnapshot | null>(username, SNAPSHOT_FILE, null, { fresh: true }).catch((e) => {
    console.warn("[pipedrive] stored snapshot unreadable:", e instanceof Error ? e.message : e);
    return null;
  });
  return stored?.v === 2 && stored.userId === (cfg.userId ?? null) ? stored : null;
}

/**
 * The stored copy only — never calls Pipedrive. Null when not connected or
 * never read. For prompts built while the user waits (Ask Basil).
 */
export async function getStoredPipedriveSnapshot(username: string, opts: { ownDomains?: readonly string[] } = {}): Promise<PipedriveSnapshot | null> {
  const hot = memory.get(username);
  if (hot && Date.now() - hot.readAt < MEMORY_MS) return hot.snap;
  const cfg = await getPipedriveConfig(username);
  if (!cfg.apiToken) { memory.delete(username); return null; }
  const stored = await readStored(username, cfg);
  if (!stored) return null;
  const snap = withDirectory(stored, opts.ownDomains ?? [], cfg, Date.now() - stored.at > FRESH_MS);
  memory.set(username, { snap, readAt: Date.now() });
  return snap;
}

/**
 * Read everything from Pipedrive now and store it. Used by the daily cron, on
 * connect and by "Refresh now". On failure: the last good copy, marked stale,
 * or a PipedriveError when there is none.
 */
export async function refreshPipedriveSnapshot(username: string, opts: { ownDomains?: readonly string[] } = {}): Promise<PipedriveSnapshot | null> {
  const running = inflight.get(username);
  if (running) return running;
  const p = (async () => {
    const cfg = await getPipedriveConfig(username);
    if (!cfg.apiToken) { memory.delete(username); return null; }
    try {
      const fresh = await load(username, cfg);
      await writeUserStore(username, SNAPSHOT_FILE, fresh).catch((e) =>
        console.warn("[pipedrive] snapshot not saved (next read refetches):", e instanceof Error ? e.message : e));
      const cov = Object.entries(fresh.coverage ?? {}).map(([k, v]) => `${k} ${v.count}${v.complete ? "" : " (CAPPED)"}`).join(", ");
      const withNotes = fresh.activities.filter((a) => a.done && a.note?.trim()).length;
      console.log(`[pipedrive] refreshed for ${username}: ${cov}; ${withNotes} done activities have notes`);
      const snap = withDirectory(fresh, opts.ownDomains ?? [], cfg);
      memory.set(username, { snap, readAt: Date.now() });
      return snap;
    } catch (e) {
      const stored = await readStored(username, cfg);
      if (stored) {
        console.warn(`[pipedrive] refresh failed for ${username}, keeping the copy from ${new Date(stored.at).toISOString()}:`, e instanceof Error ? e.message : e);
        const snap = withDirectory(stored, opts.ownDomains ?? [], cfg, true);
        memory.set(username, { snap, readAt: Date.now() });
        return snap;
      }
      throw e;
    }
  })().finally(() => inflight.delete(username));
  inflight.set(username, p);
  return p;
}

/**
 * The stored copy, refreshed first only when there is none yet or it is over
 * 26 hours old (the daily read was missed). Null when not connected.
 */
export async function getPipedriveSnapshot(
  username: string,
  opts: { ownDomains?: readonly string[]; fresh?: boolean } = {},
): Promise<PipedriveSnapshot | null> {
  if (opts.fresh) return refreshPipedriveSnapshot(username, opts);
  const stored = await getStoredPipedriveSnapshot(username, opts);
  if (stored && !stored.stale) return stored;
  if (!(await isPipedriveConnected(username))) return null;
  return refreshPipedriveSnapshot(username, opts);
}

/** When the stored copy was read, for "Last read …" in Settings. */
export async function pipedriveReadAt(username: string): Promise<number | null> {
  return (await getStoredPipedriveSnapshot(username))?.at ?? null;
}

export function dealUrl(companyDomain: string | undefined, id: number): string {
  return companyDomain ? `https://${companyDomain}.pipedrive.com/deal/${id}` : `https://app.pipedrive.com/deal/${id}`;
}

export function activityUrl(companyDomain: string | undefined, a: Pick<PdActivity, "id" | "dealId">): string {
  if (a.dealId) return dealUrl(companyDomain, a.dealId);
  return companyDomain ? `https://${companyDomain}.pipedrive.com/activities/list` : "https://app.pipedrive.com/activities/list";
}
