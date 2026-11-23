/**
 * lib/workstreams/types.ts — the user's workstreams.
 *
 * Michael, 2026-11-23: everything he looks at should say which part of his work
 * it belongs to — operations, platform & product, research, or clients & sales
 * (clients and sales merged for now; they overlap). This is a separate axis
 * from ActionItem.category (critical / admin / personal), which is urgency-ish
 * and drives the learned behaviour priors; the two are deliberately not merged.
 *
 * Pure: shared by server and client.
 */

export type Workstream = "operations" | "product" | "research" | "clients";

export interface WorkstreamInfo {
  id: Workstream;
  label: string;
  /** What belongs here — shown in the UI and given to the classifier. */
  blurb: string;
  /** Text colour on the cream canvas (≥4.5:1) and its tint for chip backgrounds. */
  fg: string;
  bg: string;
}

export const WORKSTREAMS: readonly WorkstreamInfo[] = [
  {
    id: "operations",
    label: "Operations",
    blurb: "Running the business: finance, invoices, payroll, legal, contracts with suppliers, hiring and HR, tools and accounts, internal process, investor and board admin.",
    fg: "#3F4756",
    bg: "rgba(75,85,104,.12)",
  },
  {
    id: "product",
    label: "Platform & Product",
    blurb: "Building the platform and products: engineering, bugs, releases, design, specs, roadmap, data and AI features, Linear issues.",
    fg: "#24497F",
    bg: "rgba(47,95,168,.11)",
  },
  {
    id: "research",
    label: "Research",
    blurb: "Research and analysis: market and competitor research, studies, papers, analyst work, evaluating ideas and technologies.",
    fg: "#5E4A1F",
    bg: "rgba(200,169,107,.20)",
  },
  {
    id: "clients",
    label: "Clients & Sales",
    blurb: "Prospects and clients: pipeline, demos, proposals, pricing, renewals, partners, delivering for and looking after existing clients.",
    fg: "#245C41",
    bg: "rgba(47,107,79,.12)",
  },
];

export const WORKSTREAM_IDS: readonly Workstream[] = WORKSTREAMS.map((w) => w.id);

export function isWorkstream(v: unknown): v is Workstream {
  return typeof v === "string" && (WORKSTREAM_IDS as readonly string[]).includes(v);
}

export function workstreamInfo(id: Workstream | undefined | null): WorkstreamInfo | undefined {
  return id ? WORKSTREAMS.find((w) => w.id === id) : undefined;
}

/** Who decided: the user (always wins), a routing rule, or the classifier. */
export type WorkstreamBy = "user" | "rule" | "ai";

/** A routing rule the user taught Basil ("everything from guy@ is Clients & Sales"). */
export interface WorkstreamRule {
  id: string;
  field: "sender" | "domain" | "channel" | "keyword" | "project";
  /** Lowercased: an address, a domain, a Slack channel name, a word or phrase, a project name. */
  value: string;
  workstream: Workstream;
  createdAt: string;
}
