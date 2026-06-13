export type ContactDirectory = "work" | "personal";

export interface Contact {
  id: string;
  name: string;
  initials: string;
  color: string;
  title: string;
  company: string;
  email?: string;
  phone?: string; // added for WhatsApp / personal contacts
  linkedin?: string;
  location?: string;
  tags: string[];
  status: "verified" | "pending";
  type: "internal" | "external"; // internal = Example Holdings/Example Analytics team, external = clients, partners, vendors
  /**
   * Which directory this contact lives in on the Contacts page.
   * - "work" — colleagues, investors, clients, vendors (Slack / Gmail signal)
   * - "personal" — friends, family, WhatsApp contacts
   * Defaults to "work" for any legacy record missing this field.
   */
  directory: ContactDirectory;
  // Profile tab
  relationship: string;
  companyContext: string;
  // Personality tab
  personality: string;
  whatMakesThemTick: string;
  watchOut: string;
  // Activity tab
  recentActivity: string;
  activitySource: string;
  // Relationship tracking
  lastInteraction?: string; // ISO date
  // Source metadata
  /** How this contact entered the store. */
  source?: "seed" | "user-added" | "whatsapp-import" | "suggested";
  /** ISO timestamp when this record was first created in the user store. */
  createdAt?: string;
  // AI-generated profile metadata (written by generate-profile → accept flow)
  /** ISO timestamp of the most recent AI profile generation accepted by the user. */
  generatedAt?: string;
  /** Short signal-density line from the AI generator (audit/debug only). */
  profileSummary?: string;
  /**
   * True for contacts defined in this file (seed/sample data).
   * Used by the UI to render a "SAMPLE" badge so the user knows these are
   * pre-loaded examples, not contacts imported from live integrations.
   */
  _isSeedData?: true;
}

/**
 * Pre-loaded sample contacts.
 *
 * These records were hand-authored at app-build time as starting-point
 * examples.  They are NOT live-fetched from Slack, Gmail, or Zoom —
 * the inline "// Derived from:" comments describe the REAL interactions
 * that informed the writing, but the data itself is static.
 *
 * Use `SEED_CONTACT_IDS` to identify these records at runtime, e.g. to
 * render a "SAMPLE" badge or to skip them in import flows.
 */
/**
 * Sample contacts for the user-facing view.
 *
 * The `contacts` array below is fictional fixture data (every record is
 * `_isSeedData: true`, titled "(SAMPLE)"). These must NOT appear as a real
 * user's contacts — the owner reported them showing up as "random contacts"
 * after the launch PII-scrub replaced the original seed people with these
 * placeholders. They are retained ONLY for demo deployments, gated behind an
 * opt-in env flag (default OFF). Returns [] in normal operation.
 *
 * Works in both server and client bundles: server reads SHOW_SAMPLE_CONTACTS,
 * client reads the NEXT_PUBLIC_ form (the only one inlined into the browser).
 */
export function sampleContacts(): Contact[] {
  const enabled =
    process.env.SHOW_SAMPLE_CONTACTS === "true" ||
    process.env.NEXT_PUBLIC_SHOW_SAMPLE_CONTACTS === "true";
  return enabled ? contacts : [];
}

export const contacts: Contact[] = [
  {
    id: "contact-01",
    name: "Jordan Avery",
    initials: "JA",
    color: "bg-blue-600",
    title: "CEO, Example Holdings (SAMPLE)",
    company: "Example Holdings",
    email: "jordan.avery@example.com",
    location: "Sample City, USA",
    tags: ["investor", "leadership", "talentgenius", "ag-collaborator"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    companyContext: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    personality: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    whatMakesThemTick: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    watchOut: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    recentActivity: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    activitySource: "Slack, Email, Calendar",
    lastInteraction: "2026-04-08",
    _isSeedData: true,
  },
  {
    id: "contact-02",
    name: "Sam Rivera",
    initials: "SR",
    color: "bg-red-600",
    title: "COO, Example Holdings (SAMPLE)",
    company: "Example Holdings",
    email: "sam.rivera@example.com",
    location: "Sample City, USA",
    tags: ["investor", "leadership", "talentgenius", "ag-collaborator"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    companyContext: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    personality: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    whatMakesThemTick: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    watchOut: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    recentActivity: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    activitySource: "Slack, Email, Calendar",
    lastInteraction: "2026-04-12",
    _isSeedData: true,
  },
  {
    id: "contact-03",
    name: "Riley Chen",
    initials: "RC",
    color: "bg-emerald-600",
    title: "Lead Developer, Example Analytics (SAMPLE)",
    company: "Example Analytics",
    email: "riley.chen@example.com",
    tags: ["engineering", "ag-core", "leadership"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    companyContext: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    personality: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    whatMakesThemTick: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    watchOut: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    recentActivity: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    activitySource: "Slack, Calendar",
    lastInteraction: "2026-04-10",
    _isSeedData: true,
  },
  {
    id: "contact-04",
    name: "Avery Quinn",
    initials: "AQ",
    color: "bg-pink-600",
    title: "Sales Lead, Example Analytics (SAMPLE)",
    company: "Example Analytics",
    email: "avery.quinn@example.com",
    tags: ["sales", "ag-collaborator", "cross-product"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    companyContext: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    personality: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    whatMakesThemTick: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    watchOut: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    recentActivity: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    activitySource: "Slack",
    lastInteraction: "2026-04-01",
    _isSeedData: true,
  },
  {
    id: "contact-05",
    name: "Casey Morgan",
    initials: "CM",
    color: "bg-violet-600",
    title: "Marketing Lead, Example Analytics (SAMPLE)",
    company: "Example Analytics",
    email: "casey.morgan@example.com",
    tags: ["marketing", "ag-collaborator", "cross-product"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    companyContext: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    personality: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    whatMakesThemTick: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    watchOut: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    recentActivity: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    activitySource: "Slack, Email",
    lastInteraction: "2026-04-02",
    _isSeedData: true,
  },
  {
    id: "contact-06",
    name: "Drew Patel",
    initials: "DP",
    color: "bg-orange-600",
    title: "Sales & Product, Example Talent (SAMPLE)",
    company: "Example Talent",
    tags: ["sales", "product", "agentpowered"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    companyContext: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    personality: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    whatMakesThemTick: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    watchOut: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    recentActivity: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    activitySource: "Slack",
    lastInteraction: "2026-04-06",
    _isSeedData: true,
  },
  {
    id: "contact-07",
    name: "Jamie Brooks",
    initials: "JB",
    color: "bg-slate-600",
    title: "Infrastructure & Platform, Example Holdings (SAMPLE)",
    company: "Example Holdings",
    email: "jamie.brooks@example.com",
    tags: ["engineering", "infrastructure", "cross-product"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    companyContext: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    personality: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    whatMakesThemTick: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    watchOut: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    recentActivity: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    activitySource: "Email, Calendar",
    lastInteraction: "2026-04-09",
    _isSeedData: true,
  },
  {
    id: "contact-08",
    name: "Taylor Reed",
    initials: "TR",
    color: "bg-teal-600",
    title: "Engineer, Example Analytics (SAMPLE)",
    company: "Example Analytics",
    email: "taylor.reed@example.com",
    tags: ["engineering", "ag-core"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    companyContext: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    personality: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    whatMakesThemTick: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    watchOut: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    recentActivity: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    activitySource: "Slack",
    lastInteraction: "2026-04-05",
    _isSeedData: true,
  },
  {
    id: "contact-09",
    name: "Parker Cole",
    initials: "PC",
    color: "bg-green-600",
    title: "Developer, Example Analytics (SAMPLE)",
    company: "Example Analytics",
    email: "parker.cole@example.com",
    tags: ["engineering", "ag-core"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    companyContext: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    personality: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    whatMakesThemTick: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    watchOut: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    recentActivity: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    activitySource: "Slack",
    lastInteraction: "2026-03-28",
    _isSeedData: true,
  },
  {
    id: "contact-10",
    name: "Morgan Lee",
    initials: "ML",
    color: "bg-cyan-600",
    title: "Developer, Example Analytics (SAMPLE)",
    company: "Example Analytics",
    email: "morgan.lee@example.com",
    tags: ["engineering", "ag-core"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    companyContext: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    personality: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    whatMakesThemTick: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    watchOut: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    recentActivity: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    activitySource: "Slack",
    lastInteraction: "2026-03-25",
    _isSeedData: true,
  },
  {
    id: "contact-11",
    name: "Robin Hayes",
    initials: "RH",
    color: "bg-orange-600",
    title: "Programs, Example Holdings (SAMPLE)",
    company: "Example Holdings",
    email: "robin.hayes@example.com",
    location: "Sample City, USA (Pacific time)",
    tags: ["programs", "talentgenius", "web", "cross-product"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    companyContext: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    personality: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    whatMakesThemTick: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    watchOut: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    recentActivity: "SAMPLE placeholder text — synthetic fixture data describing a fictional contact, not a real person.",
    activitySource: "Slack, Calendar",
    lastInteraction: "2026-04-14",
    _isSeedData: true,
  },
];

/**
 * Set of contact IDs that are pre-loaded sample data (not imported from live
 * integrations).  Use this to render "SAMPLE" badges or skip these records in
 * export / dedup flows.
 */
export const SEED_CONTACT_IDS: ReadonlySet<string> = new Set(
  contacts.filter((c) => c._isSeedData).map((c) => c.id)
);
