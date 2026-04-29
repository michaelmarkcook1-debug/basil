"use client";

import { useChat } from "@ai-sdk/react";
import { useState, useRef, useEffect, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { emitChange, type SyncDomain } from "@/lib/sync/channel";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
  Paperclip,
} from "lucide-react";

// Per-session localStorage key — intentionally includes no username because
// the server is now the source of truth.  This is only a same-tab fast cache
// so navigating away and back restores messages instantly without a network hit.
// It is cleared on sign-out and never used as cross-device or cross-user storage.
const CHAT_STORAGE_KEY = "sage-chat-session-v2";

const toolIcons: Record<string, typeof Calendar> = {
  getCalendarEvents: Calendar,
  searchEmails: Mail,
  searchSlack: Hash,
  draftEmail: Mail,
  scheduleMeeting: Calendar,
  sendSlackMessage: Hash,
  searchDrive: FileText,
};

const ACTION_TOOLS = new Set(["draftEmail", "scheduleMeeting", "sendSlackMessage"]);

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

  const { messages, sendMessage, setMessages, addToolApprovalResponse, status } =
    useChat();

  const isActive = status === "streaming" || status === "submitted";

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
    for (const part of lastAssistant.parts) {
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

  // Hydrate messages on mount:
  // 1. Show session cache immediately (same tab, zero latency)
  // 2. Then replace with authoritative server history (cross-device, per-user)
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;

    // Fast path: restore same-session cache while server loads
    try {
      const cached = localStorage.getItem(CHAT_STORAGE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) setMessages(parsed);
      }
    } catch { /* ignore */ }

    // Authoritative path: load per-user history from server.
    // IMPORTANT: Only apply server history if the user has NOT already sent a
    // message since mount.  The fetch is async; if it completes after the first
    // exchange it must never wipe the in-flight conversation.
    fetch("/api/chat/history")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data?.messages || !Array.isArray(data.messages)) {
          serverSaved.current = true;
          return;
        }
        if (data.messages.length === 0) {
          serverSaved.current = true;
          return;
        }
        // Don't overwrite an active conversation started since mount
        if (hasSentMessage.current) {
          serverSaved.current = true;
          return;
        }
        // Convert StoredMessage → UIMessage format
        const uiMessages = data.messages.map((m: { id: string; role: string; content: string; createdAt: string }) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          parts: [{ type: "text" as const, text: m.content }],
          content: m.content,
          createdAt: new Date(m.createdAt),
        }));
        setMessages(uiMessages);
        // Sync session cache with server data
        try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(uiMessages)); } catch { /* ignore */ }
        serverSaved.current = true;
      })
      .catch(() => {
        // Server unavailable — session cache is the fallback, mark as ready
        serverSaved.current = true;
      });
  }, [setMessages]);

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

    // Server — durable, cross-device, per-user (PUT = full replace)
    const storedMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        // In AI SDK v6, text content is always in parts — there is no .content shorthand
        const textPart = m.parts?.find((p) => (p as { type: string }).type === "text") as { type: string; text: string } | undefined;
        return {
          id: m.id,
          role: m.role as "user" | "assistant",
          content: textPart?.text ?? "",
          createdAt: new Date().toISOString(),
        };
      })
      .filter((m) => m.content.trim().length > 0);

    fetch("/api/chat/history", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: storedMessages }),
    }).then(() => { serverSaved.current = true; }).catch(() => { /* best-effort */ });
  }, [status, messages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  function clearChat() {
    setMessages([]);
    try { localStorage.removeItem(CHAT_STORAGE_KEY); } catch { /* ignore */ }
    // Clear server-side history so other devices/sessions also start fresh
    fetch("/api/chat/history", { method: "DELETE" }).catch(() => { /* best-effort */ });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const hasText = input.trim().length > 0;
    const hasFiles = stagedFiles.length > 0;
    if (!hasText && !hasFiles) return;
    hasSentMessage.current = true;

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

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    const newStaged: StagedFile[] = files.map((file) => ({
      id: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
      file,
      previewUrl: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined,
    }));
    setStagedFiles((prev) => [...prev, ...newStaged]);
    // Reset input so the same file can be re-attached if removed
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const removeFile = useCallback((id: string) => {
    setStagedFiles((prev) => {
      const removed = prev.find((sf) => sf.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((sf) => sf.id !== id);
    });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-4 sm:px-6 py-3 sm:py-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Chat with Basil</h1>
          <p className="text-sm text-muted-foreground hidden sm:block">
            Ask me anything about your day, meetings, emails, or Slack.
          </p>
        </div>
        {messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearChat}
            disabled={isActive}
            className="text-xs text-muted-foreground hover:text-destructive gap-1.5 shrink-0"
            title="Clear conversation"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </header>

      <ScrollArea className="flex-1 p-3 sm:p-6" ref={scrollRef}>
        <div className="max-w-3xl mx-auto space-y-6">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-[oklch(0.72_0.15_85)] to-[oklch(0.78_0.12_85)] flex items-center justify-center mb-4">
                <Bot className="h-6 w-6 text-white" />
              </div>
              <h2 className="text-lg font-medium">Hey, Michael</h2>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                What do you need? I can check your calendar, search emails,
                draft messages, or just chat.
              </p>
              <div className="flex flex-wrap gap-2 mt-6 justify-center">
                {[
                  "What's my day look like?",
                  "Any important emails?",
                  "What's happening in Slack?",
                  "Prep me for my next meeting",
                ].map((suggestion) => (
                  <Button
                    key={suggestion}
                    variant="outline"
                    size="sm"
                    className="border-[oklch(0.72_0.15_85)]/30 hover:bg-[oklch(0.72_0.15_85)]/10"
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

          {messages.map((message) => (
            <div key={message.id} className="flex gap-3">
              <Avatar className="h-7 w-7 shrink-0 mt-0.5">
                <AvatarFallback className="text-xs bg-secondary">
                  {message.role === "user" ? (
                    <User className="h-3.5 w-3.5" />
                  ) : (
                    <Bot className="h-3.5 w-3.5 text-[oklch(0.72_0.15_85)]" />
                  )}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 space-y-2 min-w-0">
                <p className="text-xs font-medium text-muted-foreground">
                  {message.role === "user" ? "You" : "Basil"}
                </p>
                {message.parts.map((part, i) => {
                  if (part.type === "text") {
                    return (
                      <div
                        key={`${message.id}-${i}`}
                        className="text-sm leading-relaxed whitespace-pre-wrap"
                      >
                        {part.text}
                      </div>
                    );
                  }
                  // Render file attachments sent by the user
                  if (part.type === "file") {
                    const filePart = part as {
                      type: "file";
                      mediaType: string;
                      url?: string;
                      filename?: string;
                    };
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
                  // Handle tool invocations
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

                    // Approval UI for action tools
                    if (isAction && isApprovalRequested) {
                      const approval = toolPart.approval as { id: string } | undefined;
                      const toolInput = toolPart.input as Record<string, unknown>;
                      return (
                        <Card
                          key={`${message.id}-${i}`}
                          className="p-4 border-amber-500/40 bg-amber-500/5"
                        >
                          <div className="flex items-center gap-2 mb-3">
                            <ShieldCheck className="h-4 w-4 text-amber-400" />
                            <span className="text-sm font-medium text-amber-300">
                              Approval needed
                            </span>
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
                              onClick={() => {
                                if (approval?.id) {
                                  addToolApprovalResponse({
                                    id: approval.id,
                                    approved: true,
                                  });
                                }
                              }}
                            >
                              <Check className="h-3.5 w-3.5" />
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-destructive/30 text-destructive hover:bg-destructive/10 gap-1.5"
                              onClick={() => {
                                if (approval?.id) {
                                  addToolApprovalResponse({
                                    id: approval.id,
                                    approved: false,
                                  });
                                }
                              }}
                            >
                              <X className="h-3.5 w-3.5" />
                              Deny
                            </Button>
                          </div>
                        </Card>
                      );
                    }

                    return (
                      <div
                        key={`${message.id}-${i}`}
                        className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
                      >
                        <IconComponent className="h-3 w-3" />
                        <span className="font-medium">
                          {toolName.replace(/([A-Z])/g, " $1").trim()}
                        </span>
                        {isPending && (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        )}
                        {isDone && (
                          <span className="text-emerald-600">✓</span>
                        )}
                        {isDenied && (
                          <span className="text-destructive">denied</span>
                        )}
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
                  <Bot className="h-3.5 w-3.5 text-[oklch(0.72_0.15_85)]" />
                </AvatarFallback>
              </Avatar>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[oklch(0.72_0.15_85)]" />
                Thinking...
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="border-t border-border px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] bg-background/80 backdrop-blur-sm">
        <form
          onSubmit={handleSubmit}
          className="max-w-3xl mx-auto space-y-2"
        >
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
                  <span className="text-muted-foreground/60">
                    {humanSize(sf.file.size)}
                  </span>
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
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf,.txt,.md,.csv,.json"
              multiple
              className="hidden"
              onChange={handleFileChange}
            />
            {/* Paperclip button */}
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
              className="min-h-12 max-h-40 resize-none border-[oklch(0.72_0.15_85)]/20 focus-visible:ring-[oklch(0.72_0.15_85)] py-3 text-[16px] sm:text-sm"
              rows={1}
            />
            <Button
              type="submit"
              size="icon"
              disabled={isActive || (!input.trim() && stagedFiles.length === 0)}
              aria-label="Send message"
              className="h-12 w-12 shrink-0 bg-gradient-to-r from-[oklch(0.72_0.15_85)] to-[oklch(0.78_0.12_85)] hover:from-[oklch(0.78_0.12_85)] hover:to-[oklch(0.82_0.10_85)] text-white"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </form>
      </div>
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
