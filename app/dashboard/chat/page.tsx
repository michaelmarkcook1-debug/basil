"use client";

import { toStoredMessage, toUIMessage, shouldRenderApproval, receiptLabel } from "@/lib/chat/receipts";
import { useChat } from "@ai-sdk/react";
import {
  lastAssistantMessageIsCompleteWithToolCalls,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from "ai";
import { useState, useRef, useEffect, useCallback, Suspense } from "react";

/**
 * The SDK ships two helpers — one fires when all tools have executed
 * (`...WithToolCalls`), the other when all approval requests have a response
 * (`...WithApprovalResponses`). Wire BOTH so we resubmit when either
 * condition is met — covers normal tool-loop completion AND the
 * human-in-the-loop approval flow that the send/schedule tools use.
 */
function resubmitWhen({ messages }: { messages: UIMessage[] }): boolean {
  return (
    lastAssistantMessageIsCompleteWithToolCalls({ messages }) ||
    lastAssistantMessageIsCompleteWithApprovalResponses({ messages })
  );
}
import { useSearchParams, useRouter } from "next/navigation";
import { emitChange, type SyncDomain } from "@/lib/sync/channel";
import { TrustLine, UndoTool } from "@/components/chat/trust";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { downscaleImage } from "@/lib/images/downscale";
import { Markdown } from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BTN_PRIMARY, BTN_SECONDARY } from "@/components/basil/page-hero";

import {
  Send,
  Calendar,
  Mail,
  Hash,
  FileText,
  Loader2,
  Check,
  X,
  ShieldCheck,
  MessageCirclePlus,
  Paperclip,
  AlertTriangle,
  BookMarked,
  ListTodo,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Square,
  Inbox,
  Users,
  Scale,
  Briefcase,
  Sparkles,
  BellOff,
} from "lucide-react";

// Per-session localStorage key — intentionally includes no username because
// the server is now the source of truth.  This is only a same-tab fast cache
// so navigating away and back restores messages instantly without a network hit.
// It is cleared on sign-out and never used as cross-device or cross-user storage.
const CHAT_STORAGE_KEY = "sage-chat-session-v2";
/**
 * Sentinel written by clearChat. Cleared the moment the next conversation
 * starts. While present, hydration on mount skips both the localStorage and
 * server fetch paths — guaranteed empty state even if a PUT was still
 * in-flight when the user navigated away.
 */
const CHAT_CLEARED_FLAG = "sage-chat-just-cleared";

/**
 * History recall window. Previously the client pulled the ENTIRE archive (up to
 * 200 messages) into the thread. Because useChat resends the whole conversation
 * on every turn, that meant paying tokens and latency to carry months of
 * unrelated context for the rest of the session — and burying the current topic.
 */
const HISTORY_DAYS = 14;
const HISTORY_LIMIT = 40;

const toolIcons: Record<string, typeof Calendar> = {
  getCalendarEvents: Calendar,
  searchEmails: Mail,
  searchSlack: Hash,
  draftEmail: Mail,
  replyToEmail: Mail,
  respondToInvite: Calendar,
  scheduleMeeting: Calendar,
  sendSlackMessage: Hash,
  searchDrive: FileText,
  listLinearIssues: ListTodo,
  updateLinearIssueStatus: ListTodo,
};

/**
 * Maps tool names that mutate server state to the domain they affect.
 * When the chat stream finishes and any of these tools completed successfully,
 * we emit a domain change so every other open surface refreshes automatically.
 */
// Maps tool names to the domain they mutate.  In AI SDK v6 each tool call
// surfaces as a part with type "tool-<toolName>" (e.g. "tool-addAction");
// stripping the "tool-" prefix gives the key to look up here.
// When a tool completes (state === "output-available"), emitChange fires for
// its domain so every subscriber (actions page, decisions page, etc.) refreshes.
const TOOL_DOMAIN_MAP: Record<string, SyncDomain> = {
  addAction:              "actions",
  completeAction:         "actions",
  removeAction:           "actions",
  logDecision:            "decisions",
  supersedeDecision:      "decisions",
  rememberThis:           "memory",
  rememberTerm:           "memory",
  forgetMemory:           "memory",
  generateContactProfile: "contacts",
};

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "draftEmail":
      return `To: ${input.to}\nSubject: ${input.subject}\n\n${input.body}`;
    case "replyToEmail":
      return `${input.replyAll ? "Reply all" : "Reply"} — in the original thread\nTo: ${input.recipients ?? "the sender"}\n\n${input.body}`;
    case "respondToInvite": {
      const label = input.response === "accepted" ? "Accept" : input.response === "declined" ? "Decline" : "Maybe";
      const propose = input.proposedStart ? `\nPropose: ${input.proposedStart} → ${input.proposedEnd} (the organiser is emailed)` : "";
      return `${label} the invitation${propose}${input.note ? `\nNote: ${input.note}` : ""}`;
    }
    case "scheduleMeeting":
      return `${input.title}\n${input.date} at ${input.startTime} (${input.duration}min)\nAttendees: ${(input.attendees as string[])?.join(", ")}\nVideo: ${input.meetingLink ? String(input.meetingLink) : "your meeting link from Settings, if one is saved"}`;
    case "sendSlackMessage":
      return `Channel: ${input.channel}\n\n${input.message}`;
    default: {
      // `why` and `confidence` are rendered as prose above, not as input.
      const { why: _why, confidence: _confidence, ...rest } = input;
      return JSON.stringify(rest, null, 2);
    }
  }
}

/** Files the user has staged but not yet sent. */
interface StagedFile {
  id: string;
  file: File;
  /** Object URL for images, so we can show a preview. Revoked after send. */
  previewUrl?: string;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** The welcome-screen prompts. Clicking one sends it, exactly as before. */
const WELCOME_PROMPTS: { text: string; icon: typeof Calendar }[] = [
  { text: "What needs my attention today?", icon: Inbox },
  { text: "Who is blocked?", icon: Users },
  { text: "What decisions are waiting on me?", icon: Scale },
  { text: "What projects am I working on?", icon: Briefcase },
  { text: "What did I promise?", icon: ListTodo },
  { text: "What meetings need prep?", icon: Calendar },
  { text: "What AI work needs review?", icon: Sparkles },
  { text: "What can I ignore?", icon: BellOff },
];

/** Basil's mark in a gold ring — the speaker badge beside each reply. */
function BasilMark({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#07111F] ${className}`}
      style={{ boxShadow: "0 0 0 2px var(--w-paper), 0 0 0 3.5px #C8A96B" }}
    >
      <img src="/brand/basil-logo-compass.png" alt="" className="h-12 w-12 max-w-none" />
    </span>
  );
}

/** A tool step's state, as a dot: done, running (live ping), failed or stopped. */
function StepDot({ tone }: { tone: "done" | "running" | "failed" | "denied" | "archived" }) {
  if (tone === "running") {
    return (
      <span aria-hidden className="relative h-2 w-2 shrink-0">
        <span className="basil-ping absolute inset-0 rounded-full bg-[#C8A96B]" />
        <span className="absolute inset-0 rounded-full bg-[#C8A96B]" />
      </span>
    );
  }
  const fill =
    tone === "done" ? "bg-[#1F8A70]"
    : tone === "failed" ? "bg-[var(--w-stamp)]"
    : tone === "denied" ? "border-[1.5px] border-[var(--w-stamp)]"
    : "border-[1.5px] border-dashed border-[#8A8F99]";
  return <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${fill}`} />;
}

function ChatPageInner() {
  const [input, setInput] = useState("");
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [brainReady, setBrainReady] = useState<boolean | null>(null);
  const [historyMeta, setHistoryMeta] = useState<
    { total: number; returned: number; truncated: boolean } | null
  >(null);
  const [brainModel, setBrainModel] = useState<string | null>(null);
  // What Basil is carrying into this conversation — the count is the point;
  // the memory page is where to read them.
  const { data: memoryData } = useSWR<{ memories?: Array<{ pinned?: boolean; kind?: string; expiresAt?: string }> } | null>(
    "/api/memory", (u: string) => fetch(u).then((r) => (r.ok ? r.json() : null)), { revalidateOnFocus: false },
  );
  const memoryStats = memoryData?.memories
    ? {
        total: memoryData.memories.length,
        pinned: memoryData.memories.filter((m) => m.pinned).length,
        expired: memoryData.memories.filter((m) => !m.pinned && m.expiresAt && new Date(m.expiresAt).getTime() < Date.now()).length,
      }
    : null;
  const [firstName, setFirstName] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hydrated = useRef(false);
  const serverSaved = useRef(false); // prevents saving before initial load finishes
  /** Ensures the incoming ?q= param is consumed exactly once per mount. */
  const queryConsumed = useRef(false);
  /**
   * Set to true the moment the user sends any message.
   * Prevents the async server-history fetch (started on mount) from
   * overwriting the current conversation if it completes mid-session.
   */
  const hasSentMessage = useRef(false);

  const searchParams = useSearchParams();
  const router = useRouter();

  // ── useChat with auto-resubmit after tool approvals ─────────────────────────
  // The built-in `lastAssistantMessageIsCompleteWithToolCalls` only fires
  // when tools have already EXECUTED. For `needsApproval: true` tools, that
  // never happens client-side — they sit at `approval-responded` until the
  // server re-runs them. Use a custom predicate that also treats
  // approval-responded and output-denied as "resolved", so the SDK
  // resubmits as soon as the user clicks Approve OR Deny. The server then
  // runs `execute` for approved calls and emits denial outputs for denied
  // ones, completing the round-trip.
  // `stop` was previously not destructured, so a stalled stream left "Thinking…"
  // spinning with Send, Attach and New-chat all disabled FOREVER — the only
  // escape was a page reload. Ask Basil runs long tool loops on a reasoning
  // model, so a stall is not hypothetical.
  const { messages, sendMessage, setMessages, addToolApprovalResponse, status, error, stop } =
    useChat({
      sendAutomaticallyWhen: resubmitWhen,
    });

  const isActive = status === "streaming" || status === "submitted";

  // Load user's first name from settings once on mount
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { name?: string } | null) => {
        if (d?.name) setFirstName(d.name.split(" ")[0]);
      })
      .catch((err) => { console.warn("[chat] settings load failed:", err); });
  }, []);

  // Brain status on mount comes from CONFIGURATION, not a model call. Opening
  // this page used to send a real request to the assistant's model every time,
  // outside the spend meter. /api/ai/test-brain still exists for an explicit
  // connectivity test; nothing calls it just by looking.
  useEffect(() => {
    fetch("/api/ai/status")
      .then((r) => r.ok ? r.json() : null)
      .then((d: { ok?: boolean; model?: string } | null) => {
        if (d) { setBrainReady(d.ok ?? false); setBrainModel(d.model ?? null); }
        else setBrainReady(false);
      })
      .catch(() => setBrainReady(false));
  }, []);

  // When the AI stream completes, scan the last assistant message for tool
  // calls that mutate server state and broadcast domain changes so other
  // surfaces (actions page, decisions page, memory page in other tabs or
  // on the dashboard) refresh without manual user intervention.
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    // Only act on the transition into ready (stream just completed)
    if (status !== "ready" || prev === "ready") return;

    // Find the last assistant message in the completed exchange
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;

    const domainsToNotify = new Set<SyncDomain>();
    // Guard: a message that errored before any part streamed can have no `parts`.
    for (const part of lastAssistant.parts ?? []) {
      if (typeof part.type !== "string") continue;
      if (!part.type.startsWith("tool-")) continue;

      const toolName = part.type.replace("tool-", "");
      // Only emit when the tool actually completed.  In AI SDK v6 the terminal
      // success state is "output-available"; "output-error" / "output-denied" /
      // "approval-requested" all mean the tool did NOT mutate server state.
      const state = (part as Record<string, unknown>).state as string | undefined;
      if (state !== "output-available") continue;

      const domain = TOOL_DOMAIN_MAP[toolName];
      if (domain) domainsToNotify.add(domain);
    }

    domainsToNotify.forEach((d) => emitChange(d));
  }, [status, messages]);

  // ── Fresh-on-entry policy ─────────────────────────────────────────────────
  //
  // Each visit to Ask Basil starts with an empty welcome screen — no auto-
  // rehydrate from localStorage cache or server history. Prior conversations
  // remain accessible on demand via the History button (which fetches and
  // shows them as an archive), but they never pre-populate the view.
  //
  // The rationale:
  //   - Navigating Home → Ask Basil and back is "I want to ask a new thing",
  //     not "continue what I was doing yesterday". The previous behaviour
  //     made every visit feel like a stale, ongoing conversation.
  //   - History stays one click away, so nothing is lost — just not in the
  //     user's face on entry.
  //
  // We still mark `serverSaved.current = true` so the auto-save effect knows
  // any future save is genuinely a NEW turn, not a rehydration artefact.
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    serverSaved.current = true;
  }, []);

  // Consume the ?q= query param injected by dashboard search / quick-action
  // links.  Fires after the hydration effect (React runs effects in declaration
  // order), so persisted history is already loaded when sendMessage is called.
  //
  // The queryConsumed ref ensures the auto-send happens exactly once per mount
  // even if searchParams identity changes after router.replace cleans the URL.
  useEffect(() => {
    if (queryConsumed.current) return;
    queryConsumed.current = true;

    const raw = searchParams.get("q");
    const q = raw?.trim() ?? "";
    if (!q) return;

    // Replace the URL immediately so a hard refresh won't re-send the query.
    // Using replace (not push) keeps the Back button pointed at the dashboard.
    router.replace("/dashboard/chat", { scroll: false });

    // Auto-send into the conversation.
    hasSentMessage.current = true;
    sendMessage({ text: q });
  }, [searchParams, router, sendMessage]);

  // Save to server whenever a stream exchange completes (status → "ready").
  // Also keeps the session cache in sync for same-tab fast restore.
  const prevStatusRef2 = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef2.current;
    prevStatusRef2.current = status;
    if (status !== "ready" || prev === "ready") return;
    if (!hydrated.current || messages.length === 0) return;

    // Session cache — instant same-tab restore
    try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages)); } catch { /* ignore */ }

    // Server — durable, cross-device, per-user. POST = idempotent APPEND (dedup by
    // id server-side): a new session can only ADD to the archive. The old PUT-replace
    // wiped every prior conversation the moment a fresh session saved its first turn.
    // lib/chat/receipts owns the shape: every text part (a denial's
    // acknowledgement is usually the second one) and an explicit outcome per
    // tool call. The server upserts by id, so a continuation that reuses the
    // assistant id revises its earlier "approval requested" receipt.
    const storedMessages = messages
      .map((m) => toStoredMessage(m as unknown as Parameters<typeof toStoredMessage>[0]))
      .filter((m): m is NonNullable<typeof m> => m !== null);

    fetch("/api/chat/history", {
      // POST = idempotent APPEND (server dedups by id). Was PUT (replace), which
      // cleared the entire archive on the FIRST save of every fresh session —
      // silently destroying all prior conversations. A save can now only ADD.
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: storedMessages }),
    }).then(() => { serverSaved.current = true; }).catch((e: unknown) => {
      // best-effort auto-save — failure is non-fatal
      console.warn("[basil-fetch] network_error", { route: "/api/chat/history", component: "ChatPage", error: e instanceof Error ? e.message : String(e) });
    });
  }, [status, messages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  /**
   * Wipe the visible conversation and start a fresh chat.
   *
   * Resets every layer so no prior message bleeds through — including the
   * server. Using a synchronous-from-the-server-perspective PUT with `[]`
   * (instead of fire-and-forget DELETE) means navigation away mid-flight
   * can't restore old history on the next mount.
   *
   * Layers reset:
   *   - Local React state (visible messages)
   *   - `hasSentMessage` so the welcome panel + suggestion chips return
   *   - Composer input + any staged file attachments
   *   - localStorage cache (overwritten with [] so any race-y rehydrate sees empty)
   *   - Server-side history (PUT [] — atomic replace)
   *   - Collapsed-history banner state
   *
   * State sets are queued first so the UI flashes empty immediately; the
   * server write runs in the background but is fully awaited via the toast.
   */
  async function clearChat() {
    // Immediate visual reset
    setMessages([]);
    setInput("");
    setStagedFiles([]);
    setShowHistory(false);
    hasSentMessage.current = false;

    // Overwrite cache with [] (not remove) so a stale re-read of localStorage
    // by any other code path sees empty rather than the old payload.
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, "[]");
      // Sentinel: hydration-on-mount checks this and skips ALL fetches when
      // present. Cleared by the next genuine sendMessage. Survives navigation
      // away (sessionStorage), not page reloads.
      sessionStorage.setItem(CHAT_CLEARED_FLAG, "1");
    } catch { /* ignore */ }

    // Deliberately does NOT wipe the server archive. "New chat" starts a fresh
    // VISIBLE conversation while prior conversations stay in history (one click
    // away via the History button). Permanently deleting all history is a
    // separate, explicit action (DELETE /api/chat/history), never a side effect
    // of starting a new chat.
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const hasText = input.trim().length > 0;
    const hasFiles = stagedFiles.length > 0;
    if (!hasText && !hasFiles) return;
    hasSentMessage.current = true;
    // Genuine send starts — the "just cleared" sentinel no longer applies.
    try { sessionStorage.removeItem(CHAT_CLEARED_FLAG); } catch { /* ignore */ }

    let fileList: FileList | undefined;
    if (hasFiles) {
      const dt = new DataTransfer();
      stagedFiles.forEach((sf) => dt.items.add(sf.file));
      fileList = dt.files;
    }

    sendMessage({
      text: input,
      ...(fileList && { files: fileList }),
    });

    // Revoke object URLs to avoid memory leaks
    stagedFiles.forEach((sf) => {
      if (sf.previewUrl) URL.revokeObjectURL(sf.previewUrl);
    });
    setStagedFiles([]);
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    // Reset the input immediately — we're about to await, and the element is
    // reused. (Also lets the same file be re-attached after removal.)
    if (fileInputRef.current) fileInputRef.current.value = "";

    // Downscale BEFORE staging. Attachments are inlined as base64 and the whole
    // history is resent every turn, so an oversized screenshot doesn't just
    // fail its own send — it poisons every later message in the conversation.
    const processed = await Promise.all(files.map((f) => downscaleImage(f)));

    const newStaged: StagedFile[] = processed.map((file) => ({
      id: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
      file,
      previewUrl: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined,
    }));
    setStagedFiles((prev) => [...prev, ...newStaged]);
  }, []);

  const removeFile = useCallback((id: string) => {
    setStagedFiles((prev) => {
      const removed = prev.find((sf) => sf.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((sf) => sf.id !== id);
    });
  }, []);

  // History panel toggle — collapsed by default, auto-expands when Basil is responding
  const [showHistory, setShowHistory] = useState(false);
  // Lazy archive loader — fetched only when the user actually clicks History.
  // We track whether the archive has been pulled this mount so we don't
  // re-fetch on every toggle. `historyLoading` lights a spinner on the button.
  const archiveLoaded = useRef(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  useEffect(() => {
    if (isActive) setShowHistory(true);
  }, [isActive]);

  /**
   * Pull the archived conversation from `/api/chat/history` and merge it into
   * the visible message list. Called on demand from the History toggle so the
   * default page-mount experience stays clean and empty.
   *
   * If the user has already started a fresh conversation since mount we
   * PREPEND the archive — never wipe the in-flight messages.
   */
  const loadHistory = useCallback(async () => {
    if (archiveLoaded.current) return;
    archiveLoaded.current = true;
    setHistoryLoading(true);
    try {
      // A WINDOW, not the whole archive. Pulling everything dragged months of
      // unrelated conversation into the thread — and because the full history is
      // resent on every turn, you then pay tokens and latency to carry it for the
      // rest of the session.
      const res = await fetch(`/api/chat/history?days=${HISTORY_DAYS}&limit=${HISTORY_LIMIT}`);
      if (!res.ok) return;
      const data = await res.json();
      const archive = Array.isArray(data?.messages) ? data.messages : [];
      setHistoryMeta(
        typeof data?.total === "number"
          ? { total: data.total, returned: data.returned ?? archive.length, truncated: !!data.truncated }
          : null
      );
      if (archive.length === 0) return;

      // Restored receipts carry their archived outcome — pending and unknown
      // get states of their own, so nothing unfinished renders as done and
      // nothing restored can ever show Approve/Deny. (The old mapping turned
      // every non-denied receipt into a tick.)
      const uiMessages = archive.map((m: Parameters<typeof toUIMessage>[0]) =>
        toUIMessage(m) as unknown as UIMessage,
      );

      // Prepend archive so any in-progress conversation stays at the bottom
      setMessages((prev) => (prev.length === 0 ? uiMessages : [...uiMessages, ...prev]));
    } catch (e: unknown) {
      console.warn(
        "[basil-fetch] network_error",
        { route: "/api/chat/history", component: "ChatPage:loadHistory", error: e instanceof Error ? e.message : String(e) }
      );
    } finally {
      setHistoryLoading(false);
    }
  }, [setMessages]);

  // Track per-message save state: null = idle, "saving" = in flight, "saved-action"|"saved-memory" = done
  const [saveState, setSaveState] = useState<Record<string, string>>({});

  const saveChatSnippet = useCallback(async (messageId: string, content: string, type: "action" | "memory") => {
    setSaveState((prev) => ({ ...prev, [messageId + type]: "saving" }));
    try {
      const res = await fetch("/api/ledger/chat-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, content, messageId }),
      });
      if (res.ok) {
        setSaveState((prev) => ({ ...prev, [messageId + type]: "saved" }));
        // Notify the relevant domain so the tab refreshes
        emitChange(type === "action" ? "actions" : "memory");
      } else {
        setSaveState((prev) => ({ ...prev, [messageId + type]: "error" }));
      }
    } catch {
      setSaveState((prev) => ({ ...prev, [messageId + type]: "error" }));
    }
  }, []);

  // ── Shared input form rendered in both layouts ──────────────────────────────
  // Rendered inside the composer (below) rather than at the top of the page —
  // an error about the message you just sent belongs where you are looking.
  const errorBanner = error ? (() => {
    let userMessage: string = "Something went wrong. Please try again.";
    let narrowingOptions: string[] | undefined;
    try {
      const parsed = JSON.parse(error.message) as { error?: string; narrowingOptions?: string[] };
      if (parsed.error) userMessage = parsed.error;
      if (parsed.narrowingOptions) narrowingOptions = parsed.narrowingOptions;
    } catch {
      const msg = error.message ?? "";
      const looksLikeProviderError =
        /sk-|org-|openai|anthropic|rate_limit|tokens per minute|context_length/i.test(msg);
      userMessage = looksLikeProviderError
        ? "Basil encountered an error. Please try again."
        : msg || "Something went wrong. Please try again.";
    }
    return (
      <div role="alert" className="flex flex-col gap-2.5 rounded-2xl border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-4 py-3.5 text-[14px] text-[color:var(--w-ink)]">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[var(--w-rule)] bg-[var(--w-paper)]">
            <AlertTriangle className="h-4 w-4 text-[color:var(--w-stamp)]" aria-hidden />
          </span>
          <span className="pt-1 leading-relaxed">
            <strong className="font-semibold text-[color:var(--w-stamp)]">Chat unavailable:</strong> {userMessage}
            {" — "}
            <a href="/dashboard/settings" className="font-medium text-[color:var(--w-carbon)] underline underline-offset-2">
              Check Settings → Readiness
            </a>
          </span>
        </div>
        {narrowingOptions && narrowingOptions.length > 0 && (
          <div className="flex flex-wrap gap-2 pl-11">
            {narrowingOptions.map((opt) => (
              <Button
                key={opt}
                variant="outline"
                size="sm"
                className="h-auto min-h-[44px] rounded-xl border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] px-3.5 py-2 text-[13px] text-[color:var(--w-ink)] hover:border-[#C8A96B] hover:bg-[var(--w-flimsy)] hover:text-[color:var(--w-ink)]"
                onClick={() => { hasSentMessage.current = true; sendMessage({ text: opt }); }}
              >
                {opt}
              </Button>
            ))}
          </div>
        )}
      </div>
    );
  })() : null;

  const inputForm = (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2.5">
      {/* Directly above the composer, so a failure is visible where the user's
          attention already is. It previously rendered at the very top of the
          page — off-screen in any real conversation. */}
      {errorBanner}

      {/* Say what is NOT loaded. Silent windowing would read as "this is all
          your history", which is the same class of lie as an empty list on a
          failed fetch. */}
      {historyMeta?.truncated && (
        <p className="px-1 text-[12px] leading-relaxed text-[color:var(--w-ink-soft)]">
          Showing the last <span className="basil-mono">{HISTORY_DAYS}</span> days (<span className="basil-mono">{historyMeta.returned}</span> of <span className="basil-mono">{historyMeta.total}</span> messages).
          Older history is kept — ask Basil about it and it will search further back.
        </p>
      )}
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.pdf,.txt,.md,.csv,.json"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />
      {/* Staged file chips */}
      {stagedFiles.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {stagedFiles.map((sf) => (
            <div
              key={sf.id}
              className="flex min-h-[44px] items-center gap-2 rounded-xl border border-[var(--w-rule)] bg-[var(--w-flimsy)] pl-2.5 text-[13px] text-[color:var(--w-ink)]"
            >
              {sf.previewUrl ? (
                <img
                  src={sf.previewUrl}
                  alt={sf.file.name}
                  className="h-7 w-7 shrink-0 rounded-md object-cover"
                />
              ) : (
                <FileText className="h-4 w-4 shrink-0 text-[color:var(--w-ink-soft)]" aria-hidden />
              )}
              <span className="max-w-[160px] truncate">{sf.file.name}</span>
              <span className="basil-mono text-[12px] text-[color:var(--w-ink-soft)]">{humanSize(sf.file.size)}</span>
              <button
                type="button"
                onClick={() => removeFile(sf.id)}
                className="flex h-11 w-11 items-center justify-center rounded-xl text-[color:var(--w-ink-soft)] transition-colors hover:text-[color:var(--w-stamp)]"
                aria-label={`Remove ${sf.file.name}`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      {/* The composer: one cream field holding attach, the message and send.
          The gold ring marks it as the place your typing goes. */}
      <div className="flex items-end gap-1.5 rounded-2xl border border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] p-1.5 transition-[border-color,box-shadow] focus-within:border-[#C8A96B] focus-within:ring-2 focus-within:ring-[#C8A96B]">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={isActive}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach file"
          className="h-11 w-11 shrink-0 rounded-xl text-[color:var(--w-ink-soft)] hover:bg-[var(--w-tray)] hover:text-[#10213F]"
        >
          <Paperclip className="h-4 w-4" />
        </Button>
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask me anything..."
          enterKeyHint="send"
          autoComplete="off"
          autoCorrect="on"
          spellCheck
          className="min-h-11 max-h-40 resize-none rounded-xl border-0 bg-[var(--w-flimsy)] px-2 py-2.5 text-[16px] text-[color:var(--w-ink)] shadow-none placeholder:text-[color:var(--w-ink-soft)] focus-visible:ring-0 md:text-[15px]"
          rows={1}
        />
        {/* While a reply is in flight the primary control becomes Stop, so a
            stalled stream is always escapable without reloading the page. */}
        {isActive ? (
          <Button
            type="button"
            size="icon"
            onClick={() => stop()}
            aria-label="Stop generating"
            title="Stop generating"
            className="h-11 w-11 shrink-0 rounded-xl border border-[var(--w-rule-strong)] bg-[var(--w-flimsy)] text-[#10213F] hover:border-[#C8A96B] hover:bg-[var(--w-flimsy)]"
          >
            <Square className="h-4 w-4" fill="currentColor" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            disabled={!input.trim() && stagedFiles.length === 0}
            aria-label="Send message"
            className="h-11 w-11 shrink-0 rounded-xl bg-[#10213F] text-[#F6F1E7] hover:bg-[#1A2D50]"
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </form>
  );

  // ── Message list (shared between layouts) ───────────────────────────────────
  // You: navy bubbles on the right. Basil: cream cards beside its gold-ringed
  // mark, with each tool step as a compact mono row and any action that needs
  // your say-so as a navy approval panel.
  const messageList = (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {messages.map((message) => {
        const isUser = message.role === "user";
        return (
        <div key={message.id} className={`basil-rise flex gap-3 ${isUser ? "justify-end" : ""}`}>
          {!isUser && <BasilMark className="mt-0.5" />}
          <div className={`flex min-w-0 flex-col gap-2.5 ${isUser ? "max-w-[85%] items-end" : "flex-1"}`}>
            <p className={isUser ? "sr-only" : "basil-mono pt-1.5 text-[12px] uppercase tracking-[0.14em] text-[color:var(--w-ink-soft)]"}>
              {isUser ? "You" : "Basil"}
            </p>
            {(message.parts ?? []).map((part, i) => {
              if (part.type === "text") {
                const isAssistant = message.role === "assistant";
                const actionKey = message.id + "action";
                const memoryKey = message.id + "memory";
                const hasText = part.text.trim().length > 0;
                if (!isAssistant) {
                  // An attachment-only send carries an empty text part — no empty bubble.
                  if (!hasText) return null;
                  return (
                    <div key={`${message.id}-${i}`} className="rounded-2xl rounded-br-md bg-[#10213F] px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap text-[#F6F1E7]">
                      {part.text}
                    </div>
                  );
                }
                return (
                  <div
                    key={`${message.id}-${i}`}
                    className={hasText ? "rounded-[20px] rounded-tl-md border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-5 py-4 text-[color:var(--w-ink)]" : undefined}
                  >
                    <Markdown text={part.text} />
                    {isAssistant && part.text.trim().length > 0 && (
                      <div className="-mx-2 -mb-2 mt-3 flex flex-wrap gap-1 border-t border-[var(--w-tray)] pt-1.5">
                        <button
                          type="button"
                          disabled={saveState[actionKey] === "saving" || saveState[actionKey] === "saved"}
                          onClick={() => saveChatSnippet(message.id, part.text, "action")}
                          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-2.5 text-[13px] font-medium text-[color:var(--w-ink-soft)] transition-colors hover:bg-[var(--w-tray)] hover:text-[#10213F] disabled:opacity-50"
                          title="Save as action"
                        >
                          {saveState[actionKey] === "saving" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : saveState[actionKey] === "saved" ? (
                            <Check className="h-3.5 w-3.5 text-[color:var(--w-filed)]" />
                          ) : (
                            <ListTodo className="h-3.5 w-3.5" />
                          )}
                          {saveState[actionKey] === "saved" ? "Saved" : "→ Action"}
                        </button>
                        <button
                          type="button"
                          disabled={saveState[memoryKey] === "saving" || saveState[memoryKey] === "saved"}
                          onClick={() => saveChatSnippet(message.id, part.text, "memory")}
                          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-2.5 text-[13px] font-medium text-[color:var(--w-ink-soft)] transition-colors hover:bg-[var(--w-tray)] hover:text-[#10213F] disabled:opacity-50"
                          title="Save to memory"
                        >
                          {saveState[memoryKey] === "saving" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : saveState[memoryKey] === "saved" ? (
                            <Check className="h-3.5 w-3.5 text-[color:var(--w-filed)]" />
                          ) : (
                            <BookMarked className="h-3.5 w-3.5" />
                          )}
                          {saveState[memoryKey] === "saved" ? "Saved" : "→ Memory"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              }
              if (part.type === "file") {
                const filePart = part as { type: "file"; mediaType: string; url?: string; filename?: string };
                const isImage = filePart.mediaType?.startsWith("image/");
                if (isImage && filePart.url) {
                  return (
                    <img
                      key={`${message.id}-${i}`}
                      src={filePart.url}
                      alt={filePart.filename ?? "attachment"}
                      className="max-h-60 w-fit max-w-xs rounded-2xl border border-[var(--w-rule)] object-cover"
                    />
                  );
                }
                return (
                  <div
                    key={`${message.id}-${i}`}
                    className="inline-flex w-fit items-center gap-2 rounded-xl border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-3 py-2 text-[13px] text-[color:var(--w-ink)]"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-[color:var(--w-ink-soft)]" aria-hidden />
                    <span className="max-w-[200px] truncate">
                      {filePart.filename ?? filePart.mediaType ?? "file"}
                    </span>
                  </div>
                );
              }
              if (part.type.startsWith("tool-")) {
                const toolName = part.type.replace("tool-", "");
                const IconComponent = toolIcons[toolName] || FileText;
                const toolPart = part as Record<string, unknown>;
                const state = toolPart.state as string | undefined;
                const isApprovalRequested = state === "approval-requested";
                const isDone = state === "output-available" || state === "done";
                const isDenied = state === "output-denied";
                const isFailed = state === "output-error";
                const isArchived = state === "archived-pending" || state === "archived-unknown";
                // A spinner means "still running". Archived rows are not running.
                const isPending = !isDone && !isApprovalRequested && !isDenied && !isFailed && !isArchived;

                // Any tool the server marked approval-requested gets controls —
                // there is no allowlist to fall out of step with lib/ai/tools.ts.
                // (addAction and five other approval tools were missing from it.)
                if (shouldRenderApproval(toolPart)) {
                  const approval = toolPart.approval as { id: string } | undefined;
                  const toolInput = toolPart.input as Record<string, unknown>;
                  return (
                    <section
                      key={`${message.id}-${i}`}
                      aria-label="Approval needed"
                      className="basil-rise flex flex-col gap-3 rounded-[20px] bg-[#10213F] p-5 text-[#F6F1E7] sm:p-6"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <ShieldCheck className="h-4 w-4 text-[#D4B978]" aria-hidden />
                          <span className="basil-serif text-[24px] leading-tight text-[#D4B978]">Approval needed</span>
                        </span>
                        <span className="basil-mono inline-flex items-center gap-1.5 text-[12px] uppercase tracking-[0.12em] text-[#F6F1E7]">
                          <IconComponent className="h-3.5 w-3.5 text-[#D4B978]" aria-hidden />
                          {toolName.replace(/([A-Z])/g, " $1").trim()}
                        </span>
                      </div>
                      {/* Why this, now — the model's one sentence to the user — and how
                          sure it is. Both are the model's own claims and are labelled so. */}
                      {typeof toolInput?.why === "string" && toolInput.why.trim() !== "" && (
                        <p className="text-[15px] leading-relaxed text-[#F6F1E7]">{toolInput.why}</p>
                      )}
                      {toolInput && (
                        <pre className="basil-mono whitespace-pre-wrap rounded-2xl bg-[#1A2D50] p-4 text-[13px] leading-relaxed text-[#F6F1E7]">
                          {formatToolInput(toolName, toolInput)}
                        </pre>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          className="h-11 gap-1.5 rounded-xl bg-[#D4B978] px-4 text-[14px] font-semibold text-[#10213F] hover:bg-[#C8A96B]"
                          onClick={() => { if (approval?.id) addToolApprovalResponse({ id: approval.id, approved: true }); }}
                        >
                          <Check className="h-3.5 w-3.5" /> Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-11 gap-1.5 rounded-xl border-[#F6F1E7] bg-[#10213F] px-4 text-[14px] font-medium text-[#F6F1E7] hover:border-[#D4B978] hover:bg-[#1A2D50] hover:text-[#F6F1E7]"
                          onClick={() => { if (approval?.id) addToolApprovalResponse({ id: approval.id, approved: false }); }}
                        >
                          <X className="h-3.5 w-3.5" /> Deny
                        </Button>
                      </div>
                      <TrustLine tool={toolName} />
                    </section>
                  );
                }

                const tone = isPending ? "running" : isDone ? "done" : isFailed ? "failed" : isDenied ? "denied" : isArchived ? "archived" : null;
                return (
                  <div key={`${message.id}-${i}`} className="basil-mono flex min-h-[28px] flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[12px] text-[color:var(--w-ink-soft)]">
                    {tone ? <StepDot tone={tone} /> : <span aria-hidden className="h-2 w-2 shrink-0" />}
                    <IconComponent className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="font-medium">{toolName.replace(/([A-Z])/g, " $1").trim()}</span>
                    {isPending && <span>running</span>}
                    {isDone && <span className="text-[color:var(--w-filed)]">{receiptLabel(state).label}</span>}
                    {isDenied && <span className="text-[color:var(--w-stamp)]">{receiptLabel(state).label}</span>}
                    {isFailed && <span className="text-[color:var(--w-stamp)]">{receiptLabel(state).label}</span>}
                    {isArchived && <span className="text-[color:var(--w-manila)]">{receiptLabel(state).label}</span>}
                    {isDone && <UndoTool toolName={toolName} output={toolPart.output} />}
                  </div>
                );
              }
              return null;
            })}
          </div>
        </div>
        );
      })}

      {isActive && messages[messages.length - 1]?.role === "user" && (
        <div className="basil-rise flex items-center gap-3">
          <BasilMark />
          <div className="flex items-center gap-2.5 text-[14px] text-[color:var(--w-ink-soft)]">
            <StepDot tone="running" />
            Thinking...
          </div>
        </div>
      )}
    </div>
  );

  return (
    // Wire scope goes on the inner component: the page root is a Suspense
    // boundary, which renders no element of its own to carry the world.
    <div className="wire relative isolate flex h-full flex-col">
      {/* The one permitted wash: a faint gold glow behind the title, clipped
          to the page so it never adds a horizontal scroll. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <span
          className="absolute -right-40 -top-56 h-[460px] w-[680px] rounded-full"
          style={{ background: "radial-gradient(closest-side, rgba(212,185,120,.26), transparent 72%)" }}
        />
      </div>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="basil-rise flex flex-wrap items-end justify-between gap-4 border-b border-[var(--w-rule)] px-4 py-4 sm:px-8 sm:py-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="basil-serif text-[36px] leading-[0.95] tracking-[-0.02em] text-[#10213F] sm:text-[44px]">
            Ask Basil<span className="text-[#C8A96B]">.</span>
          </h1>
          <p className="hidden text-[15px] leading-relaxed text-[color:var(--w-ink-soft)] sm:block">
            Ask me anything about your day, meetings, emails, or Slack.
          </p>
          {/* Brain ready status — what model is answering and what Basil is
              carrying into the conversation. */}
          {brainReady === true && brainModel && (
            <p className="basil-mono flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 text-[12px] text-[color:var(--w-ink-soft)]">
              <span className="inline-flex items-center gap-1.5 font-medium text-[color:var(--w-filed)]">
                <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-[#1F8A70]" />
                AI ready
              </span>
              <span aria-hidden>·</span>
              <span>{brainModel}</span>
              {memoryStats && (
                <>
                  <span aria-hidden>·</span>
                  <a href="/dashboard/memory" className="text-[color:var(--w-carbon)] underline-offset-2 hover:underline">
                    {memoryStats.total} {memoryStats.total === 1 ? "memory" : "memories"} on file
                    {memoryStats.pinned > 0 ? ` · ${memoryStats.pinned} pinned` : ""}
                    {memoryStats.expired > 0 ? ` · ${memoryStats.expired} expired` : ""}
                  </a>
                </>
              )}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* "New chat" — always available so it's a consistent, discoverable
              affordance. Disabled when there's nothing to clear or when a
              message is in flight (so we don't tear state out mid-response). */}
          <button
            type="button"
            onClick={clearChat}
            disabled={isActive || messages.length === 0}
            className={BTN_SECONDARY}
            title="Start a fresh conversation and clear all visible history"
            aria-label="New chat"
          >
            <MessageCirclePlus className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">New chat</span>
          </button>
          {/* History is ALWAYS available — clicking it lazy-loads the archive
              from the server. We don't gate on messages.length so users can
              still reach prior conversations even on a fresh-entry view. */}
          <button
            type="button"
            onClick={() => {
              // Opening: pull the archive in the background, then toggle.
              if (!showHistory) {
                void loadHistory();
              }
              setShowHistory((v) => !v);
            }}
            disabled={historyLoading}
            className={BTN_SECONDARY}
            title={showHistory ? "Collapse chat history" : "Show previous conversations"}
          >
            {historyLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <MessageSquare className="h-4 w-4" aria-hidden />
            )}
            {showHistory ? (
              <>History <ChevronUp className="h-3.5 w-3.5" aria-hidden /></>
            ) : (
              <>History <ChevronDown className="h-3.5 w-3.5" aria-hidden /></>
            )}
          </button>
        </div>
      </header>

      {/* Brain loading spinner */}
      {brainReady === null && (
        <div className="flex flex-1 items-center justify-center" role="status" aria-label="Loading">
          <Loader2 className="h-6 w-6 animate-spin text-[color:var(--w-ink-soft)]" />
        </div>
      )}

      {/* Brain not configured — full blocking panel */}
      {brainReady === false && (
        <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
          <section
            aria-labelledby="ai-down-h"
            className="basil-rise flex w-full max-w-md flex-col items-start gap-4 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-6 sm:p-7"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--w-rule)] bg-[var(--w-paper)]">
              <AlertTriangle className="h-5 w-5 text-[color:var(--w-stamp)]" aria-hidden />
            </span>
            <h2 id="ai-down-h" className="basil-serif text-[30px] leading-tight text-[#10213F]">AI not reachable</h2>
            <p className="text-[15px] leading-relaxed text-[color:var(--w-ink-soft)]">
              Basil couldn&apos;t reach the AI provider. Set one of the following environment variables in your Vercel project.
            </p>
            <div className="w-full space-y-1.5 rounded-2xl border border-[var(--w-rule)] bg-[var(--w-paper)] px-4 py-3.5 text-[14px] text-[color:var(--w-ink)]">
              <p><code className="basil-mono font-semibold text-[#10213F]">BASIL_LLM_KEY</code> — Anthropic API key <span className="text-[color:var(--w-ink-soft)]">(preferred)</span></p>
              <p><code className="basil-mono font-semibold text-[#10213F]">AI_GATEWAY_API_KEY</code> — Vercel AI Gateway key</p>
            </div>
            <a href="/dashboard/settings?tab=brain" className={BTN_PRIMARY}>
              Open Settings → Brain
            </a>
          </section>
        </div>
      )}

      {brainReady === true && (
        <>
          {/* ── Conversation layout ─────────────────────────────────────────
              Gated on messages ALONE, deliberately. This was
              `showHistory && messages.length > 0`, which tied the LIVE thread to
              the History toggle: clicking "Collapse chat history" made the
              conversation you were in the middle of vanish. The toggle's job is
              to pull in PREVIOUS conversations (see loadHistory above), not to
              decide whether the current one is visible. */}
          {messages.length > 0 ? (
            <>
              <ScrollArea className="flex-1 px-4 py-5 sm:px-8 sm:py-8" ref={scrollRef}>
                {messageList}
              </ScrollArea>
              <div className="border-t border-[var(--w-rule)] bg-[var(--w-paper)] px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8">
                <div className="mx-auto max-w-3xl">
                  {inputForm}
                </div>
              </div>
            </>
          ) : (
            /* ── Centered layout (default / history collapsed) ────────────── */
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6 sm:px-8 sm:py-10">
              <div className="mx-auto my-auto flex w-full max-w-3xl flex-col gap-6">
                {/* Welcome panel — shown when no messages yet */}
                {messages.length === 0 && (
                  <div className="flex flex-col gap-6">
                    <div className="basil-rise flex flex-col gap-3" style={{ animationDelay: "60ms" }}>
                      <span className="basil-mono inline-flex items-center gap-3 text-[12px] uppercase tracking-[0.14em] text-[color:var(--w-ink-soft)]">
                        <BasilMark />
                        {firstName ? `Hey, ${firstName}` : "Hey"}
                      </span>
                      <h2
                        className="basil-serif max-w-[660px] text-[32px] leading-[1.08] tracking-[-0.01em] text-[#10213F] sm:text-[44px]"
                        style={{ textWrap: "balance" }}
                      >
                        What do you want to know about your day, your people or your work?
                      </h2>
                      <p className="max-w-[560px] text-[15px] leading-relaxed text-[color:var(--w-ink-soft)]">
                        I can check your calendar, search emails, draft messages, or just chat.
                      </p>
                    </div>
                    {/* Rise on the item, lift on the button: one element cannot
                        hold both, the rise's fill would pin the hover transform. */}
                    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Suggested questions">
                      {WELCOME_PROMPTS.map(({ text: suggestion, icon: Icon }, i) => (
                        <li key={suggestion} className="basil-rise" style={{ animationDelay: `${140 + i * 70}ms` }}>
                          <button
                            type="button"
                            className="basil-lift flex min-h-[64px] w-full items-center gap-3.5 rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] px-4 py-3 text-left text-[15px] font-medium leading-snug text-[color:var(--w-ink)]"
                            onClick={() => {
                              hasSentMessage.current = true;
                              sendMessage({ text: suggestion });
                            }}
                          >
                            <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#10213F]">
                              <Icon className="h-4 w-4 text-[#D4B978]" />
                            </span>
                            {suggestion}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* "Show previous conversations" affordance — shown ONLY on
                    the empty welcome state, so users with no current in-flight
                    convo still know archived chats are reachable. Hidden once
                    they start typing/sending so the welcome panel isn't
                    cluttered mid-conversation. */}
                {messages.length === 0 && !showHistory && !archiveLoaded.current && (
                  <button
                    onClick={() => {
                      void loadHistory();
                      setShowHistory(true);
                    }}
                    disabled={historyLoading}
                    className={`${BTN_SECONDARY} self-start`}
                  >
                    {historyLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <MessageSquare className="h-4 w-4" aria-hidden />
                    )}
                    <span>Show previous conversations</span>
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}

                {/* Always-visible quick prompts — surfaced whenever the user
                    isn't actively composing, even mid-conversation. The
                    empty-state above is the welcome panel for first-load only;
                    this row is for "what now?" between turns. */}
                {messages.length > 0 && !input.trim() && (
                  <div className="flex w-full flex-wrap gap-2">
                    {[
                      "What needs my attention?",
                      "Who's waiting on me?",
                      "Summarise the last meeting",
                      "What can I close out today?",
                    ].map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        className={BTN_SECONDARY}
                        onClick={() => {
                          hasSentMessage.current = true;
                          sendMessage({ text: suggestion });
                        }}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                )}

                {/* The composer — a cream field with a gold focus ring. */}
                <div className="basil-rise w-full" style={{ animationDelay: "120ms" }}>
                  {inputForm}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense>
      <ChatPageInner />
    </Suspense>
  );
}
