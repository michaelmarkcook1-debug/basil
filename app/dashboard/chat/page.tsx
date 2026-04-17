"use client";

import { useChat } from "@ai-sdk/react";
import { useState, useRef, useEffect } from "react";
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
} from "lucide-react";

const CHAT_STORAGE_KEY = "sage-chat-messages-v1";

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

export default function ChatPage() {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const hydrated = useRef(false);

  const { messages, sendMessage, setMessages, addToolApprovalResponse, status } =
    useChat();

  const isActive = status === "streaming" || status === "submitted";

  // Hydrate messages from localStorage on mount — keeps the conversation alive
  // when the user clicks away to another sidebar page and back.
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    try {
      const cached = localStorage.getItem(CHAT_STORAGE_KEY);
      if (!cached) return;
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) {
        setMessages(parsed);
      }
    } catch {
      /* ignore bad cache */
    }
  }, [setMessages]);

  // Persist messages whenever they change. Skip the initial render so we
  // don't clobber existing cache with an empty array before hydration lands.
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      if (messages.length === 0) {
        localStorage.removeItem(CHAT_STORAGE_KEY);
      } else {
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages));
      }
    } catch {
      /* localStorage full or unavailable */
    }
  }, [messages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  function clearChat() {
    setMessages([]);
    try {
      localStorage.removeItem(CHAT_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    sendMessage({ text: input });
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold bg-gradient-to-r from-[oklch(0.22_0.05_250)] to-[oklch(0.35_0.06_250)] bg-clip-text text-transparent">Chat</h1>
          <p className="text-sm text-muted-foreground">
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

      <div className="border-t border-border px-4 py-4 bg-background/80 backdrop-blur-sm">
        <form
          onSubmit={handleSubmit}
          className="max-w-3xl mx-auto flex items-end gap-2"
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask me anything..."
            className="min-h-12 max-h-40 resize-none border-[oklch(0.72_0.15_85)]/20 focus-visible:ring-[oklch(0.72_0.15_85)] py-3"
            rows={1}
          />
          <Button
            type="submit"
            size="icon"
            disabled={isActive || !input.trim()}
            aria-label="Send message"
            className="h-12 w-12 shrink-0 bg-gradient-to-r from-[oklch(0.72_0.15_85)] to-[oklch(0.78_0.12_85)] hover:from-[oklch(0.78_0.12_85)] hover:to-[oklch(0.82_0.10_85)] text-white"
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
