/**
 * lib/pipedrive/client.ts — Pipedrive CRM, read-only, with the user's personal
 * API token (Settings → Personal preferences → API in Pipedrive).
 *
 *   - The token is kept encrypted per user (secure-token-store "pipedrive"),
 *     never in env vars and never shared between Basil accounts.
 *   - API v2 (deals, activities, persons, organizations, stages): v2 list
 *     calls cost Pipedrive's daily token budget less than v1. Only /users/me
 *     is v1 (no v2 equivalent).
 *   - Results are cached per user for 15 minutes in memory. The Today feed
 *     reads activities and the client directory once per background refresh,
 *     so a busy day costs a few hundred of the account's ~30,000 daily tokens.
 *   - Basil never writes to Pipedrive.
 */
import "server-only";
import { getIntegrationToken, saveIntegrationToken, deleteIntegrationToken } from "@/lib/storage/secure-token-store";
import { buildDirectory, domainFromWebsite, emailDomain, type CrmDirectory, type PdActivity, type PdDeal, type PdOrg, type PdPerson } from "@/lib/pipedrive/shape";

const V2 = "https://api.pipedrive.com/api/v2";
const V1 = "https://api.pipedrive.com/v1";
const TIMEOUT_MS = 10_000;
const CACHE_MS = 15 * 60 * 1000;
const MAX_PAGES = 5;

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
  cache.delete(username);
  await deleteIntegrationToken(username, "pipedrive");
}

export class PipedriveError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function call<T>(token: string, url: string): Promise<{ data: T; next?: string | null }> {
  const res = await fetch(url, {
    headers: { "x-api-token": token, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 401) throw new PipedriveError("Pipedrive rejected the API token (401). Paste a current token in Settings.", 401);
  if (res.status === 429) throw new PipedriveError("Pipedrive's daily API budget is used up (429). It resets tomorrow.", 429);
  if (!res.ok) throw new PipedriveError(`Pipedrive ${res.status}`, res.status);
  const body = (await res.json()) as { success?: boolean; data?: T; error?: string; additional_data?: { next_cursor?: string | null } };
  if (body.success === false) throw new PipedriveError(body.error ?? "Pipedrive returned an error", res.status);
  return { data: body.data as T, next: body.additional_data?.next_cursor };
}

/** GET a v2 list, following cursors up to MAX_PAGES × 500 records. */
async function list<T>(token: string, path: string, params: Record<string, string | number | boolean | undefined>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ limit: 500, ...params, cursor })) if (v !== undefined && v !== "") q.set(k, String(v));
    const { data, next } = await call<T[] | null>(token, `${V2}${path}?${q}`);
    out.push(...(data ?? []));
    if (!next) break;
    cursor = next;
  }
  return out;
}

/** Check a token and learn whose it is. Used when connecting. */
export async function validatePipedriveToken(apiToken: string): Promise<Required<Omit<PipedriveConfig, "apiToken" | "connectedAt">>> {
  const { data } = await call<{ id: number; name: string; email: string; company_name: string; company_domain: string }>(apiToken, `${V1}/users/me`);
  if (!data?.id) throw new PipedriveError("Pipedrive did not say whose token this is.", 400);
  return { userId: data.id, userName: data.name, userEmail: data.email, companyName: data.company_name, companyDomain: data.company_domain };
}

export async function savePipedriveToken(username: string, apiToken: string): Promise<PipedriveConfig> {
  const who = await validatePipedriveToken(apiToken);
  const cfg: PipedriveConfig = { apiToken, ...who, connectedAt: new Date().toISOString() };
  await saveIntegrationToken(username, "pipedrive", cfg);
  cache.delete(username);
  return cfg;
}

// ── Raw v2 shapes (only the fields Basil reads) ──────────────────────────────

interface RawActivity { id: number; subject: string; type: string; due_date: string | null; due_time: string | null; deal_id: number | null; person_id: number | null; org_id: number | null; note?: string | null; update_time: string; done?: boolean }
interface RawDeal { id: number; title: string; value: number; currency: string; stage_id: number; status: string; person_id: number | null; org_id: number | null; expected_close_date: string | null; update_time: string; stage_change_time: string | null }
interface RawPerson { id: number; name: string; emails?: { value: string }[] | null; org_id: number | null; job_title?: string | null }
interface RawOrg { id: number; name: string; website?: string | null }
interface RawStage { id: number; name: string }

const stripHtml = (s?: string | null) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);

// ── Cached reads ─────────────────────────────────────────────────────────────

interface Snapshot {
  at: number;
  activities: PdActivity[];
  deals: PdDeal[];
  persons: PdPerson[];
  orgs: PdOrg[];
  directory: CrmDirectory;
}
const cache = new Map<string, Snapshot>();
const inflight = new Map<string, Promise<Snapshot | null>>();

async function load(username: string, ownDomains: readonly string[]): Promise<Snapshot | null> {
  const cfg = await getPipedriveConfig(username);
  if (!cfg.apiToken) return null;
  const t = cfg.apiToken;
  const owner = cfg.userId;
  const [rawActs, rawDeals, rawPersons, rawOrgs, rawStages] = await Promise.all([
    list<RawActivity>(t, "/activities", { owner_id: owner, done: false, sort_by: "due_date", sort_direction: "asc" }),
    list<RawDeal>(t, "/deals", { owner_id: owner, status: "open", sort_by: "update_time", sort_direction: "desc" }),
    list<RawPerson>(t, "/persons", { sort_by: "update_time", sort_direction: "desc" }),
    list<RawOrg>(t, "/organizations", { sort_by: "update_time", sort_direction: "desc" }),
    list<RawStage>(t, "/stages", {}),
  ]);
  const stageName = new Map(rawStages.map((s) => [s.id, s.name]));
  const persons: PdPerson[] = rawPersons.map((p) => ({
    id: p.id, name: p.name, orgId: p.org_id ?? null,
    emails: (p.emails ?? []).map((e) => e.value).filter(Boolean),
    ...(p.job_title ? { jobTitle: p.job_title } : {}),
  }));
  const orgs: PdOrg[] = rawOrgs.map((o) => ({ id: o.id, name: o.name, ...(o.website ? { website: o.website, domain: domainFromWebsite(o.website) } : {}) }));
  const own = [...ownDomains, ...(cfg.userEmail ? [emailDomain(cfg.userEmail) ?? ""] : [])].filter(Boolean);
  return {
    at: Date.now(),
    activities: rawActs.filter((a) => !a.done).map((a) => ({
      id: a.id, subject: a.subject, type: a.type, dueDate: a.due_date, dueTime: a.due_time ? a.due_time.slice(0, 5) : null,
      dealId: a.deal_id ?? null, personId: a.person_id ?? null, orgId: a.org_id ?? null,
      ...(a.note ? { note: stripHtml(a.note) } : {}), updateTime: a.update_time,
    })),
    deals: rawDeals.map((d) => ({
      id: d.id, title: d.title, value: d.value ?? 0, currency: d.currency, stage: stageName.get(d.stage_id) ?? `Stage ${d.stage_id}`,
      status: d.status, personId: d.person_id ?? null, orgId: d.org_id ?? null, expectedClose: d.expected_close_date ?? null,
      updateTime: d.update_time, stageChangeTime: d.stage_change_time ?? null,
    })),
    persons,
    orgs,
    directory: buildDirectory(persons, orgs, own),
  };
}

/**
 * Everything Basil reads from Pipedrive, cached 15 minutes. Null when not
 * connected. Throws PipedriveError when connected but the read fails — callers
 * report that as "Pipedrive degraded", never as "nothing in Pipedrive".
 */
export async function getPipedriveSnapshot(username: string, opts: { ownDomains?: readonly string[]; fresh?: boolean } = {}): Promise<Snapshot | null> {
  const hit = cache.get(username);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit;
  const running = inflight.get(username);
  if (running) return running;
  const p = load(username, opts.ownDomains ?? [])
    .then((s) => { if (s) cache.set(username, s); else cache.delete(username); return s; })
    .finally(() => inflight.delete(username));
  inflight.set(username, p);
  return p;
}

export function dealUrl(companyDomain: string | undefined, id: number): string {
  return companyDomain ? `https://${companyDomain}.pipedrive.com/deal/${id}` : `https://app.pipedrive.com/deal/${id}`;
}

export function activityUrl(companyDomain: string | undefined, a: Pick<PdActivity, "id" | "dealId">): string {
  if (a.dealId) return dealUrl(companyDomain, a.dealId);
  return companyDomain ? `https://${companyDomain}.pipedrive.com/activities/list` : "https://app.pipedrive.com/activities/list";
}

export type { Snapshot as PipedriveSnapshot };
