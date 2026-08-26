"use client";

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
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { downscaleImage } from "@/lib/images/downscale";
import { Markdown } from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

import {
  Send,
  Bot,
  User,
  Calendar,
  Mail,
  Hash,
  FileText,
  Loader2,
  Check,
  X,
  ShieldCheck,
  Trash2,
  MessageCirclePlus,
  Paperclip,
  AlertTriangle,
  BookMarked,
  ListTodo,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Square,
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
  scheduleMeeting: Calendar,
  sendSlackMessage: Hash,
  searchDrive: FileText,
  listLinearIssues: ListTodo,
  updateLinearIssueStatus: ListTodo,
};

const ACTION_TOOLS = new Set([
  "draftEmail",
  "scheduleMeeting",
  "sendSlackMessage",
  "updateLinearIssueStatus",
]);

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
  forgetMemory:           "memory",
  generateContactProfile: "contacts",
};

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "draftEmail":
      return `To: ${input.to}\nSubject: ${input.subject}\n\n${input.body}`;
    case "scheduleMeeting":
      return `${input.title}\n${input.date} at ${input.startTime} (${input.duration}min)\nAttendees: ${(input.attendees as string[])?.join(", ")}`;
    case "sendSlackMessage":
      return `Channel: ${input.channel}\n\n${input.message}`;
    default:
      return JSON.stringify(input, null, 2);
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

function ChatPageInner() {
  const [input, setInput] = useState("");
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [brainReady, setBrainReady] = useState<boolean | null>(null);
  const [historyMeta, setHistoryMeta] = useState<
    { total: number; returned: number; truncated: boolean } | null
  >(null);
  const [brainModel, setBrainModel] = useState<string | null>(null);
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

  // Check brain status once on mount
  useEffect(() => {
    fetch("/api/ai/test-brain")
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
    const storedMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        // In AI SDK v6, text content is always in parts — there is no .content shorthand
        const textPart = m.parts?.find((p) => (p as { type: string }).type === "text") as { type: string; text: string } | undefined;
        // Tool receipts — WHAT Basil actually did (drafted an email, booked a
        // meeting, etc.) was previously never archived; only the answer text
        // that happened to follow was saved. Capture a lightweight summary
        // (name + final state + input) so history reflects real actions taken.
        const toolReceipts = (m.parts ?? [])
          .filter((p) => typeof (p as { type?: unknown }).type === "string" && (p as { type: string }).type.startsWith("tool-"))
          .map((p) => {
            const tp = p as Record<string, unknown>;
            const toolName = (tp.type as string).replace("tool-", "");
            const state = typeof tp.state === "string" ? tp.state : "unknown";
            return { toolName, state, input: tp.input };
          })
          // Cap serialized size per receipt so a large draft body can't bloat storage.
          .map((r) => {
            const json = JSON.stringify(r.input ?? {});
            return json.length > 1000 ? { ...r, input: { truncated: true } } : r;
          });
        return {
          id: m.id,
          role: m.role as "user" | "assistant",
          content: textPart?.text ?? "",
          createdAt: new Date().toISOString(),
          ...(toolReceipts.length > 0 ? { toolReceipts } : {}),
        };
      })
      // A tool-only message (no text) still records what Basil did — don't drop it.
      .filter((m) => m.content.trim().length > 0 || (m.toolReceipts?.length ?? 0) > 0);

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

      const uiMessages = archive.map((m: {
        id: string; role: string; content: string; createdAt: string;
        toolReceipts?: Array<{ toolName: string; state: string; input?: unknown }>;
      }) => {
        const parts: Array<Record<string, unknown>> = [];
        if (m.content) parts.push({ type: "text" as const, text: m.content });
        // Rehydrate archived tool receipts as synthetic tool parts — reuses the
        // existing tool-part renderer (icon + name + done/denied state) so a
        // reopened conversation shows what Basil actually did, not just the reply.
        for (const r of m.toolReceipts ?? []) {
          parts.push({
            type: `tool-${r.toolName}`,
            state: r.state === "output-denied" ? "output-denied" : "output-available",
            input: r.input,
          });
        }
        return {
          id: m.id,
          role: m.role as "user" | "assistant",
          // Synthetic tool parts are dynamically shaped per tool name — same
          // pattern as the live renderer's `part as Record<string, unknown>` cast.
          parts: parts as unknown as UIMessage["parts"],
          content: m.content,
          createdAt: new Date(m.createdAt),
        };
      });

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
      <div className="mx-4 mt-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive space-y-2">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            <strong>Chat unavailable:</strong> {userMessage}
            {" — "}
            <a href="/dashboard/settings" className="underline">
              Check Settings → Readiness
            </a>
          </span>
        </div>
        {narrowingOptions && narrowingOptions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pl-6">
            {narrowingOptions.map((opt) => (
              <Button
                key={opt}
                variant="outline"
                size="sm"
                className="text-xs border-destructive/30 text-destructive hover:bg-destructive/10 h-auto py-1"
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
    <form onSubmit={handleSubmit} className="space-y-2">
      {/* Directly above the composer, so a failure is visible where the user's
          attention already is. It previously rendered at the very top of the
          page — off-screen in any real conversation. */}
      {errorBanner}

      {/* Say what is NOT loaded. Silent windowing would read as "this is all
          your history", which is the same class of lie as an empty list on a
          failed fetch. */}
      {historyMeta?.truncated && (
        <p className="px-1 text-[11px] text-muted-foreground">
          Showing the last {HISTORY_DAYS} days ({historyMeta.returned} of {historyMeta.total} messages).
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
        <div className="flex flex-wrap gap-1.5">
          {stagedFiles.map((sf) => (
            <div
              key={sf.id}
              className="group relative flex items-center gap-1.5 rounded-md border border-border bg-muted/50 pl-2 pr-1 py-1 text-xs text-muted-foreground"
            >
              {sf.previewUrl ? (
                 
                <img
                  src={sf.previewUrl}
                  alt={sf.file.name}
                  className="h-5 w-5 rounded object-cover shrink-0"
                />
              ) : (
                <FileText className="h-3 w-3 shrink-0" />
              )}
              <span className="max-w-[140px] truncate">{sf.file.name}</span>
              <span className="text-muted-foreground/60">{humanSize(sf.file.size)}</span>
              <button
                type="button"
                onClick={() => removeFile(sf.id)}
                className="ml-0.5 rounded p-0.5 opacity-60 hover:opacity-100 hover:text-destructive transition-opacity"
                aria-label={`Remove ${sf.file.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={isActive}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach file"
          className="h-12 w-12 shrink-0 text-muted-foreground hover:text-foreground"
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
          className="min-h-12 max-h-40 resize-none border-[var(--w-rule)] focus-visible:ring-[var(--w-carbon)] py-3 text-[16px] sm:text-sm"
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
            className="h-12 w-12 shrink-0 border border-border/60 bg-card text-foreground hover:bg-card/70"
          >
            <Square className="h-4 w-4" fill="currentColor" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            disabled={!input.trim() && stagedFiles.length === 0}
            aria-label="Send message"
            className="h-12 w-12 shrink-0 bg-[var(--w-carbon)] hover:bg-[var(--w-ink)] text-white"
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </form>
  );

  // ── Message list (shared between layouts) ───────────────────────────────────
  const messageList = (
    <div className="max-w-3xl mx-auto space-y-6">
      {messages.map((message) => (
        <div key={message.id} className="flex gap-3">
          <Avatar className="h-7 w-7 shrink-0 mt-0.5">
            <AvatarFallback className="text-xs bg-secondary">
              {message.role === "user" ? (
                <User className="h-3.5 w-3.5" />
              ) : (
                <Bot className="h-3.5 w-3.5 text-[color:var(--w-carbon)]" />
              )}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 space-y-2 min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              {message.role === "user" ? "You" : "Basil"}
            </p>
            {(message.parts ?? []).map((part, i) => {
              if (part.type === "text") {
                const isAssistant = message.role === "assistant";
                const actionKey = message.id + "action";
                const memoryKey = message.id + "memory";
                return (
                  <div key={`${message.id}-${i}`}>
                    {isAssistant
                      ? <Markdown text={part.text} />
                      : <div className="text-sm leading-relaxed whitespace-pre-wrap">{part.text}</div>}
                    {isAssistant && part.text.trim().length > 0 && (
                      <div className="mt-2 flex gap-1.5">
                        <button
                          type="button"
                          disabled={saveState[actionKey] === "saving" || saveState[actionKey] === "saved"}
                          onClick={() => saveChatSnippet(message.id, part.text, "action")}
                          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                          title="Save as action"
                        >
                          {saveState[actionKey] === "saving" ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : saveState[actionKey] === "saved" ? (
                            <Check className="h-3 w-3 text-signal-positive" />
                          ) : (
                            <ListTodo className="h-3 w-3" />
                          )}
                          {saveState[actionKey] === "saved" ? "Saved" : "→ Action"}
                        </button>
                        <button
                          type="button"
                          disabled={saveState[memoryKey] === "saving" || saveState[memoryKey] === "saved"}
                          onClick={() => saveChatSnippet(message.id, part.text, "memory")}
                          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                          title="Save to memory"
                        >
                          {saveState[memoryKey] === "saving" ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : saveState[memoryKey] === "saved" ? (
                            <Check className="h-3 w-3 text-signal-positive" />
                          ) : (
                            <BookMarked className="h-3 w-3" />
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
                      className="max-w-xs max-h-60 rounded-lg border border-border object-cover"
                    />
                  );
                }
                return (
                  <div
                    key={`${message.id}-${i}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground"
                  >
                    <FileText className="h-3 w-3 shrink-0" />
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
                const isAction = ACTION_TOOLS.has(toolName);
                const isApprovalRequested = state === "approval-requested";
                const isDone = state === "output-available" || state === "done";
                const isDenied = state === "output-denied";
                const isPending = !isDone && !isApprovalRequested && !isDenied;

                if (isAction && isApprovalRequested) {
                  const approval = toolPart.approval as { id: string } | undefined;
                  const toolInput = toolPart.input as Record<string, unknown>;
                  return (
                    <Card key={`${message.id}-${i}`} className="p-4 border-signal-warning/40 bg-signal-warning-subtle">
                      <div className="flex items-center gap-2 mb-3">
                        <ShieldCheck className="h-4 w-4 text-signal-warning" />
                        <span className="text-sm font-medium text-signal-warning">Approval needed</span>
                      </div>
                      <div className="flex items-center gap-2 mb-2">
                        <IconComponent className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-xs font-medium text-muted-foreground">
                          {toolName.replace(/([A-Z])/g, " $1").trim()}
                        </span>
                      </div>
                      {toolInput && (
                        <pre className="text-sm bg-background/50 rounded-md p-3 mb-3 whitespace-pre-wrap">
                          {formatToolInput(toolName, toolInput)}
                        </pre>
                      )}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white gap-1.5"
                          onClick={() => { if (approval?.id) addToolApprovalResponse({ id: approval.id, approved: true }); }}
                        >
                          <Check className="h-3.5 w-3.5" /> Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-destructive/30 text-destructive hover:bg-destructive/10 gap-1.5"
                          onClick={() => { if (approval?.id) addToolApprovalResponse({ id: approval.id, approved: false }); }}
                        >
                          <X className="h-3.5 w-3.5" /> Deny
                        </Button>
                      </div>
                    </Card>
                  );
                }

                return (
                  <div key={`${message.id}-${i}`} className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                    <IconComponent className="h-3 w-3" />
                    <span className="font-medium">{toolName.replace(/([A-Z])/g, " $1").trim()}</span>
                    {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                    {isDone && <span className="text-signal-positive">✓</span>}
                    {isDenied && <span className="text-destructive">denied</span>}
                  </div>
                );
              }
              return null;
            })}
          </div>
        </div>
      ))}

      {isActive && messages[messages.length - 1]?.role === "user" && (
        <div className="flex gap-3">
          <Avatar className="h-7 w-7 shrink-0 mt-0.5">
            <AvatarFallback className="text-xs bg-secondary">
              <Bot className="h-3.5 w-3.5 text-[color:var(--w-carbon)]" />
            </AvatarFallback>
          </Avatar>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[color:var(--w-carbon)]" />
            Thinking...
          </div>
        </div>
      )}
    </div>
  );

  return (
    // Wire scope goes on the inner component: the page root is a Suspense
    // boundary, which renders no element of its own to carry the world.
    <div className="wire flex h-full flex-col">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-border px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Ask Basil</h1>
          <p className="text-sm text-muted-foreground hidden sm:block">
            Ask me anything about your day, meetings, emails, or Slack.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* "New chat" — always available so it's a consistent, discoverable
              affordance. Disabled when there's nothing to clear or when a
              message is in flight (so we don't tear state out mid-response). */}
          <Button
            variant="outline"
            size="sm"
            onClick={clearChat}
            disabled={isActive || messages.length === 0}
            className="gap-1.5 border-[var(--w-rule)] text-[oklch(0.55_0.12_85)] hover:bg-[var(--w-carbon-tint)] hover:text-[color:var(--w-carbon)] hover:border-[var(--w-rule)] disabled:opacity-40"
            title="Start a fresh conversation and clear all visible history"
          >
            <MessageCirclePlus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">New chat</span>
          </Button>
          {/* History is ALWAYS available — clicking it lazy-loads the archive
              from the server. We don't gate on messages.length so users can
              still reach prior conversations even on a fresh-entry view. */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // Opening: pull the archive in the background, then toggle.
              if (!showHistory) {
                void loadHistory();
              }
              setShowHistory((v) => !v);
            }}
            disabled={historyLoading}
            className="text-xs text-muted-foreground hover:text-foreground gap-1.5"
            title={showHistory ? "Collapse chat history" : "Show previous conversations"}
          >
            {historyLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <MessageSquare className="h-3.5 w-3.5" />
            )}
            {showHistory ? (
              <>History <ChevronUp className="h-3 w-3" /></>
            ) : (
              <>History <ChevronDown className="h-3 w-3" /></>
            )}
          </Button>
        </div>
      </header>

      {/* Brain loading spinner */}
      {brainReady === null && (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Brain not configured — full blocking panel */}
      {brainReady === false && (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border-2 border-signal-critical-border bg-signal-critical-subtle">
            <AlertTriangle className="h-7 w-7 text-signal-critical" />
          </div>
          <h2 className="text-xl font-semibold text-foreground">AI not reachable</h2>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            Basil couldn&apos;t reach the AI provider. Set one of the following environment variables in your Vercel project.
          </p>
          <div className="mt-4 rounded-lg border border-signal-critical-border bg-signal-critical-subtle px-5 py-4 text-left text-sm text-signal-critical space-y-1 w-full max-w-sm">
            <p><code className="font-mono font-semibold">BASIL_LLM_KEY</code> — Anthropic API key <span className="text-signal-critical/70">(preferred)</span></p>
            <p><code className="font-mono font-semibold">AI_GATEWAY_API_KEY</code> — Vercel AI Gateway key</p>
          </div>
          <div className="mt-5 flex gap-3">
            <a
              href="/dashboard/settings?tab=brain"
              className="inline-flex items-center rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 transition-opacity"
            >
              Open Settings → Brain
            </a>
          </div>
        </div>
      )}

      {brainReady === true && (
        <>
          {/* Brain ready status bar */}
          {brainModel && (
            <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg border border-signal-positive-border bg-signal-positive-subtle/50 px-3 py-1.5 text-xs text-signal-positive">
              <div className="h-1.5 w-1.5 rounded-full bg-signal-positive shrink-0" />
              <span className="font-medium">AI ready</span>
              <span className="text-signal-positive/70">·</span>
              <span className="font-mono">{brainModel}</span>
            </div>
          )}


          {/* ── Conversation layout ─────────────────────────────────────────
              Gated on messages ALONE, deliberately. This was
              `showHistory && messages.length > 0`, which tied the LIVE thread to
              the History toggle: clicking "Collapse chat history" made the
              conversation you were in the middle of vanish. The toggle's job is
              to pull in PREVIOUS conversations (see loadHistory above), not to
              decide whether the current one is visible. */}
          {messages.length > 0 ? (
            <>
              <ScrollArea className="flex-1 p-3 sm:p-6" ref={scrollRef}>
                {messageList}
              </ScrollArea>
              <div className="border-t border-border px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] bg-background/80 backdrop-blur-sm">
                <div className="max-w-3xl mx-auto">
                  {inputForm}
                </div>
              </div>
            </>
          ) : (
            /* ── Centered layout (default / history collapsed) ────────────── */
            <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 sm:px-6">
              <div className="w-full max-w-2xl flex flex-col items-center gap-6">
                {/* Welcome panel — shown when no messages yet */}
                {messages.length === 0 && (
                  <div className="text-center">
                    <div className="h-12 w-12 rounded-xl bg-[var(--w-carbon)] flex items-center justify-center mb-4 mx-auto">
                      <Bot className="h-6 w-6 text-white" />
                    </div>
                    <h2 className="text-lg font-medium">{firstName ? `Hey, ${firstName}` : "Hey"}</h2>
                    <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                      What do you need? I can check your calendar, search emails,
                      draft messages, or just chat.
                    </p>
                    <div className="flex flex-wrap gap-2 mt-5 justify-center">
                      {[
                        "What needs my attention today?",
                        "Who is blocked?",
                        "What decisions are waiting on me?",
                        "What projects am I working on?",
                        "What did I promise?",
                        "What meetings need prep?",
                        "What AI work needs review?",
                        "What can I ignore?",
                      ].map((suggestion) => (
                        <Button
                          key={suggestion}
                          variant="outline"
                          size="sm"
                          className="border-[var(--w-rule)] hover:bg-[var(--w-carbon-tint)]"
                          onClick={() => {
                            hasSentMessage.current = true;
                            sendMessage({ text: suggestion });
                          }}
                        >
                          {suggestion}
                        </Button>
                      ))}
                    </div>
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
                    className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-2 rounded-lg border border-border/60 hover:border-border bg-muted/30 hover:bg-muted/60 disabled:opacity-50"
                  >
                    {historyLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <MessageSquare className="h-3.5 w-3.5" />
                    )}
                    <span>Show previous conversations</span>
                    <ChevronDown className="h-3 w-3" />
                  </button>
                )}

                {/* Always-visible quick prompts — surfaced whenever the user
                    isn't actively composing, even mid-conversation. The
                    empty-state above is the welcome panel for first-load only;
                    this row is for "what now?" between turns. */}
                {messages.length > 0 && !input.trim() && (
                  <div className="w-full flex flex-wrap gap-2 justify-center">
                    {[
                      "What needs my attention?",
                      "Who's waiting on me?",
                      "Summarise the last meeting",
                      "What can I close out today?",
                    ].map((suggestion) => (
                      <Button
                        key={suggestion}
                        variant="outline"
                        size="sm"
                        className="border-[var(--w-rule)] hover:bg-[var(--w-carbon-tint)]"
                        onClick={() => {
                          hasSentMessage.current = true;
                          sendMessage({ text: suggestion });
                        }}
                      >
                        {suggestion}
                      </Button>
                    ))}
                  </div>
                )}

                {/* Centered input box with subtle tinted background */}
                <div className="w-full rounded-2xl border border-[var(--w-rule)] bg-[oklch(0.97_0.008_85)] dark:bg-card/80 shadow-sm px-3 py-3">
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
