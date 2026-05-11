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
  type: "internal" | "external"; // internal = TalentGenius/AG team, external = clients, partners, vendors
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
export const contacts: Contact[] = [
  {
    id: "malcolm-frank",
    name: "Malcolm Frank",
    initials: "MF",
    color: "bg-blue-600",
    title: "CEO, TalentGenius (Holding Company)",
    company: "TalentGenius",
    email: "malcolm@talentgenius.io",
    location: "Florida, USA",
    tags: ["investor", "leadership", "talentgenius", "ag-collaborator"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "Investor and CEO of the holding company. Michael reports into Malcolm. Key decision-maker for AG and AP/TG direction.",
    companyContext: "Holding company behind AnalystGenius, AgentPowered/TalentGenius, and BoardRadar. Malcolm is CEO and one of the investors/leadership across all products.",
    // Derived from: Slack — forwards Anthropic tweets, shares X links, posts Morgan Stanley AI signals, shares board member insights on F500 expectations. Email — forwards 'Tech Conf 2026 AI Signals' to core team, took Michael's market doc to Claude for deeper analysis on automation opportunities.
    personality: "Big-picture strategic thinker who connects macro signals to product thesis. Forwards Anthropic tweets, Morgan Stanley AI reports, and board member insights unprompted. Took Michael's market background doc and independently ran it through Claude to explore automation angles — intellectually hands-on, not just directive. Communicates in short, decisive bursts: 'Looks great. Big step forward.' or 'Agreed. Let's go!' When he wants changes, he's direct but constructive: 'Overall looks great. But let's discuss live — some nuanced changes.' Warm but businesslike.",
    whatMakesThemTick: "Market intelligence, AI trends, and the intellectual challenge of disrupting the analyst industry. Genuinely excited by the AG concept — he's always reading, always forwarding relevant signals. Responds to well-structured thinking and market insight. Loves when someone connects dots between industry data and product direction.",
    watchOut: "Moves fast and expects the same. Will drop a 'Can we schedule an AG product review this week?' with 2 days' notice. Gives short, positive feedback ('Looks great') which can feel like approval but may come with caveats ('let's discuss live before you publish'). If you're presenting to him, bring data and sharp analysis — not status updates. His silence on a thread usually means he's processing, not disengaged.",
    recentActivity: "Accepted AG Product Review (Apr 8). Forwarded Tech Conf 2026 AI Signals report to core team. Reviewed Isaac's TalentGenius.io site changes — approved direction but flagged nuanced changes needed. Shared board member insights on F500 expectations for AI analysis modules. Approved video content: 'I like the B roll. I'd publish this as is.'",
    activitySource: "Slack, Email, Calendar",
    lastInteraction: "2026-04-08",
    _isSeedData: true,
  },
  {
    id: "ed-baum",
    name: "Ed Baum",
    initials: "EB",
    color: "bg-red-600",
    title: "COO, TalentGenius (Holding Company)",
    company: "TalentGenius",
    email: "ed@talentgenius.io",
    location: "USA",
    tags: ["investor", "leadership", "talentgenius", "ag-collaborator"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "COO and investor. Michael reports to Ed. Operationally focused — the man who gets everything moving and done.",
    companyContext: "TalentGenius holding company. Ed is COO and co-investor alongside Malcolm. Runs TG Leadership meetings, GTM standups, and drives accountability across all products.",
    // Derived from: Slack — posts GTM action lists, sends reminders before meetings, tracks Anthropic certification completion, creates Slack task lists from Trey's inputs, shares branding decisions. Email — sends TG Leadership invites, AG naming meetings.
    personality: "Operational executor. Posts reminders ('A reminder before our meeting — please update the Anthropic GTM Actions list'), creates structured task lists, and tracks completion. Uses @here notifications to drive urgency. Confirms alignment quickly ('That makes a lot of sense to me', 'I think this looks great!'). Asks precise structural questions about product architecture ('I am assuming BoardRadar and AnalystGenius are offers inside /companies?'). Concise communicator — rarely writes more than 2 sentences.",
    whatMakesThemTick: "Execution and accountability. Loves seeing task lists get completed, deadlines met, and decisions made. Gets energy from moving things from plan to done. Values clarity and structure — if there's a list, he'll track it. Drove the Anthropic partnership GTM actions with military-like precision across the team.",
    watchOut: "Tracks commitments closely — if you said it would be done by Friday, he remembers. Uses @here and direct reminders without hesitation, which means he expects action within hours, not days. His positive responses ('looks great', 'makes sense') are genuine approvals — he doesn't hedge. But his silence on a task means he's waiting for your update, not that he forgot. Come to 1-on-1s with specifics on what shipped and what didn't.",
    recentActivity: "Announced TalentGenius as the overall brand name (replacing AgentPowered). Shared Trey's Week 2 Anthropic GTM actions list. Sent reminders for Anthropic training completion. Invited team to TG/AP naming session. Updated TG Leadership recurring meeting. Reviewed and approved Isaac's AP platform transformation plan.",
    activitySource: "Slack, Email, Calendar",
    lastInteraction: "2026-04-12",
    _isSeedData: true,
  },
  {
    id: "isaac-frank",
    name: "Isaac Frank",
    initials: "IF",
    color: "bg-emerald-600",
    title: "Lead Developer",
    company: "AG / BR / AP",
    email: "isaac@talentgenius.io",
    tags: ["engineering", "ag-core", "leadership"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "Lead developer bridging AG, BoardRadar, and AP/TG. Michael's primary technical partner on AG V1.0.",
    companyContext: "Spans all three products. Primary dev lead for AnalystGenius, also drives the TalentGenius.io site rebuild and AgentPowered platform transformation.",
    // Derived from: Slack — posts detailed site architecture with code blocks, writes structured plans with phases, sends staged changes for review, engages in architectural discussions with Ed.
    personality: "Highly structured communicator. Posts detailed, well-formatted plans with headers, bullet points, and code blocks. Thinks in phases — 'Phase 1: Now' / 'Phase 2: Next'. Proactively shares architectural decisions and rationale before being asked. Pushes back diplomatically when scope creeps: 'I am extremely partial to route 1' (keeping TG focused on TG). Takes Malcolm's feedback constructively and discusses live when needed.",
    whatMakesThemTick: "Building coherent systems. Cares deeply about product architecture making sense at a structural level. Gets satisfaction from taking vague direction and turning it into a clean, executable plan. Values autonomy to propose solutions, not just execute specs.",
    watchOut: "His detailed plans are proposals — they need explicit approval before he builds. He'll wait for confirmation rather than assume a green light. If Malcolm says 'let's discuss live,' Isaac pauses until that conversation happens. Give him clear go/no-go signals. His plans can be dense — read them carefully, because the strategic choices are buried in the structure.",
    recentActivity: "Staged TalentGenius.io site changes — 90/10 buyer-focused homepage with role-based landing pages. Shared full AP platform transformation plan (marketplace to agency model). Posted site navigation architecture for Ed/Malcolm review. API endpoint updates for AG analyst dashboard.",
    activitySource: "Slack, Calendar",
    lastInteraction: "2026-04-10",
    _isSeedData: true,
  },
  {
    id: "olivia-bond-keith",
    name: "Olivia Bond-Keith",
    initials: "OB",
    color: "bg-pink-600",
    title: "Sales Lead",
    company: "AG / BR / TG",
    tags: ["sales", "ag-collaborator", "cross-product"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "Sales lead shared across AG, BoardRadar, and TalentGenius. Key person for AG and AP go-to-market.",
    companyContext: "Leads sales efforts across multiple products. Built the first ICP and 200-lead list for Anthropic GTM push.",
    // Derived from: Slack — shared ICP draft and lead list right before AP meeting, timing suggests works-to-deadline style.
    personality: "Action-oriented and deadline-driven. Shared an ICP draft and 200-lead list minutes before a team call — works right up to the wire but delivers. Communicates in short, practical updates. Comfortable sharing work-in-progress rather than waiting for perfection.",
    whatMakesThemTick: "Pipeline momentum. Energised by having real prospects to work. Motivated by clear ICPs and positioning she can take to market. Needs the product story nailed down to sell confidently.",
    watchOut: "Works across AG, BR, and TG — can be stretched thin. AG priorities may compete with AP/TG outreach pushes. If outreach was supposed to start and didn't, dig into whether it was capacity or clarity that blocked it. Her timing before meetings suggests she responds to deadlines — set them explicitly.",
    recentActivity: "Shared first draft ICP and 200-lead list for Anthropic GTM initiative. Active on AP launch channel before meetings.",
    activitySource: "Slack",
    lastInteraction: "2026-04-01",
    _isSeedData: true,
  },
  {
    id: "crystal-parra",
    name: "Crystal Parra",
    initials: "CP",
    color: "bg-violet-600",
    title: "Marketing Lead",
    company: "AG / BR / TG",
    email: "crystal@talentgenius.io",
    tags: ["marketing", "ag-collaborator", "cross-product"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "Marketing lead shared across AG, BoardRadar, and TalentGenius. Driving AG launch content and brand.",
    companyContext: "Handles marketing, content, and brand across the portfolio. Included in TG Leadership and naming discussions.",
    // Derived from: Slack — posts detailed marketing status updates with bullet points covering BR paid social, AG sample ads, SEO strategy. Suggests lead capture forms. Email — included in TG Leadership invites and naming sessions.
    personality: "Organized, detail-oriented marketer who thinks in structured updates. Posts multi-product status reports with bullet points covering paid social metrics (CTR benchmarks), SEO strategy, content builds, and sample assets. Proactive with suggestions — spotted the need for a lead capture form mid-scroll. Flags concerns directly: 'concerned no conversions' despite good CTR.",
    whatMakesThemTick: "Seeing campaigns perform and brand come together. Gets energy from tangible assets — sample ads, content calendars, video drafts. Motivated by clear brand direction she can execute against. Values data: tracks CTR against benchmarks, flags performance gaps.",
    watchOut: "Blocked when brand/naming decisions stall — the company naming decision has held up her work. Had a Zoom link issue for a 1:1 (wrong link in calendar invite) which may have meant a meeting didn't happen. Stretched across AG, BR, and TG marketing simultaneously. If she goes quiet, it usually means she's waiting on a decision from above, not that she's idle.",
    recentActivity: "Shared BR paid social performance update (1.5% CTR vs 0.5% benchmark, but no conversions). Posted AG sample ads and video content from Claude. Outlined SEO and content strategy across BR and AG. Suggested lead capture form for website. Included in TG/AP naming meeting invite.",
    activitySource: "Slack, Email",
    lastInteraction: "2026-04-02",
    _isSeedData: true,
  },
  {
    id: "trey-carlson",
    name: "Trey Carlson",
    initials: "TC",
    color: "bg-orange-600",
    title: "AP Sales & Product",
    company: "AgentPowered / TG",
    tags: ["sales", "product", "agentpowered"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "80% sales, 20% product/marketing for AgentPowered/TalentGenius. Drives Anthropic partnership GTM actions.",
    companyContext: "Primarily focused on AgentPowered/TalentGenius GTM. Key driver of the Anthropic partnership certification and launch actions.",
    // Derived from: Slack — posts structured weekly updates, owns the Anthropic GTM action list, sends advance updates when missing meetings, completed Anthropic certification.
    personality: "Reliable, structured communicator who posts advance updates when he can't attend meetings — never leaves people hanging. Creates actionable task lists that Ed then operationalises. Owns the Anthropic GTM action list and drives it forward weekly. Balances sales and product work without complaining about the split.",
    whatMakesThemTick: "Seeing product-market fit come together. Motivated by the Anthropic partnership opportunity — drove the certification through. Likes having a clear action list and working through it methodically. Values being trusted with both sales and product responsibilities.",
    watchOut: "Split between sales and product means AG priorities can slip behind AP/TG work. His task lists are his commitments — if something's not on the list, it's not being tracked. Make sure AG actions are explicitly added. His PTO updates show good intent but the team needs to verify actions actually completed in his absence.",
    recentActivity: "Completed Anthropic certification (both Ed and Olivia confirmed). Posted Week 2 Anthropic GTM actions list. Sent advance update for missed AP call. Working with Isaac on TalentGenius.io site changes.",
    activitySource: "Slack",
    lastInteraction: "2026-04-06",
    _isSeedData: true,
  },
  {
    id: "christopher-walton",
    name: "Christopher Walton",
    initials: "CW",
    color: "bg-slate-600",
    title: "Infrastructure & Platform",
    company: "All Products",
    email: "cwalton@talentgenius.io",
    tags: ["engineering", "infrastructure", "cross-product"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "Infrastructure/platform lead across all products — AG, AP/TG, BR.",
    companyContext: "Supports infrastructure across the entire portfolio. Included in Malcolm's AI signals forwards and TG Leadership meetings.",
    personality: "Behind-the-scenes operator. Rarely posts in Slack but is included on all critical email threads — Malcolm's AI signals forward, TG Leadership invites, naming sessions. Works across the full stack quietly. His presence on emails suggests he's trusted with the technical foundation of everything.",
    whatMakesThemTick: "Reliable systems and clean architecture. Doing things right so they don't break at scale. Being included in strategic decisions that affect infrastructure.",
    watchOut: "Low visibility in Slack means you may underestimate his workload. He's supporting AG, AP, BR, and TG infrastructure simultaneously. Check in on capacity directly — he won't broadcast if he's overloaded.",
    recentActivity: "Included on Malcolm's AI Signals forward to core team. Invited to TG Leadership meetings and TG/AP naming session. Infrastructure support across platforms.",
    activitySource: "Email, Calendar",
    lastInteraction: "2026-04-09",
    _isSeedData: true,
  },
  {
    id: "matt-paquette",
    name: "Matt Paquette",
    initials: "MP",
    color: "bg-teal-600",
    title: "AG Engineer",
    company: "AnalystGenius",
    tags: ["engineering", "ag-core"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "AG engineer working alongside Isaac on V1.0 development.",
    companyContext: "AnalystGenius development team. Works on infrastructure and feature development for V1.0.",
    personality: "Ships quietly and effectively. Deployment pipeline fix went live without fanfare — just a Slack update confirming it's done. Low ceremony, high output.",
    whatMakesThemTick: "Solving hard technical problems with clear priorities and autonomy to execute.",
    watchOut: "Won't flag concerns loudly. Check in proactively on anything critical. His updates are terse — 'fix is live' means it's done, not that it needs discussion.",
    recentActivity: "Deployment pipeline fix is live. CI/CD stabilised.",
    activitySource: "Slack",
    lastInteraction: "2026-04-05",
    _isSeedData: true,
  },
  {
    id: "djuan-g",
    name: "Djuan G.",
    initials: "DG",
    color: "bg-green-600",
    title: "AG Developer",
    company: "AnalystGenius",
    tags: ["engineering", "ag-core"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "AG dev team member working on V1.0 features.",
    companyContext: "AnalystGenius development team.",
    personality: "Steady contributor who works within sprint structure. Keeps heads down and delivers.",
    whatMakesThemTick: "Clear sprint goals and well-defined tickets. Knowing what success looks like.",
    watchOut: "May need context on the bigger picture occasionally — share the 'why' behind priority changes.",
    recentActivity: "Active on AG engineering sprint tasks.",
    activitySource: "Slack",
    lastInteraction: "2026-03-28",
    _isSeedData: true,
  },
  {
    id: "logan-carlson",
    name: "Logan Carlson",
    initials: "LC",
    color: "bg-cyan-600",
    title: "AG Developer",
    company: "AnalystGenius",
    tags: ["engineering", "ag-core"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "AG dev team member.",
    companyContext: "AnalystGenius development team.",
    personality: "Task-oriented. Good at turning specs into working code quickly.",
    whatMakesThemTick: "Shipping features. Clear requirements and fast feedback loops.",
    watchOut: "Prefers written specs over verbal briefs. Document what you need.",
    recentActivity: "Sprint work on AG V1.0 features.",
    activitySource: "Slack",
    lastInteraction: "2026-03-25",
    _isSeedData: true,
  },
  {
    id: "mike-trujillo",
    name: "Mike Trujillo",
    initials: "MT",
    color: "bg-orange-600",
    title: "Programs",
    company: "TalentGenius",
    email: "mike@talentgenius.io",
    location: "USA (Pacific time)",
    tags: ["programs", "talentgenius", "web", "cross-product"],
    status: "verified",
    type: "internal",
    directory: "work",
    relationship: "Runs programs across TalentGenius — coordinates the web/site workstream, bridges design (Dirce) and engineering (Adrian, Christopher Walton, Isaac). A different Mike than Michael Cook — don't conflate.",
    companyContext: "TalentGenius holding company. Mike owns program delivery on the .app / .io site rebuild and related web initiatives. Works closely with outside devs and designers, coordinates QA↔Prod parity, and tracks feature changes into Slack #dev.",
    // Derived from: Slack #dev — posts structured progress updates with numbered/bulleted task lists, coordinates between Adrian (dev) and Dirce (design), tracks QA/Prod parity, drives site changes across home/discover/solutions pages. Calendar — attendee on AP GTM standup alongside Malcolm/Ed/Trey.
    personality: "Program-manager energy — organizes work into numbered task lists and keeps everyone on the same page. Writes status updates like a punch list ('1. category list matches .app site, 2. solutions wired up on prod, 3. light mode for solution pages'). Coordinates across developers and designers, flags when environments drift ('QA site needs to reflect the same status as Prod'). Direct and practical — no fluff, just what's done and what's next.",
    whatMakesThemTick: "Delivery and alignment. Gets energy from seeing environments match, task lists get closed out, and cross-functional work land cleanly. Wants everyone operating off the same current state — hates when QA and Prod drift. Values clear ownership handoffs between design, dev, and program management.",
    watchOut: "West Coast timezone — 8 hours behind London, so late-evening London calls (like 18:30) are mid-morning for him but his async Slack updates arrive in Michael's evening/night. His name is 'Mike' in Slack/email — easy to confuse with Michael Cook. When he posts a numbered list, treat it as the actual scope — he's explicit about what's in and what's out. If something isn't on his list, assume it hasn't been formally accepted into the workstream.",
    recentActivity: "Posted #dev status update (Apr 14) coordinating Adrian on home/discover/solutions page changes — 'Dirce has a new design — mike will PR'. Tracking QA/Prod parity across TalentGenius site. Attending AP GTM standup (Apr 15) with Malcolm/Ed/Trey/Crystal/Olivia/Isaac.",
    activitySource: "Slack #dev, Calendar",
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
