"use client";

import { useState, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2,
  Mail,
  Send,
  FileText,
  Check,
  Sparkles,
  Wand2,
} from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
}

type Mode = "compose" | "success";

export function DraftEmailModal({ open, onClose }: Props) {
  // Form state
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [naturalText, setNaturalText] = useState("");

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [lastAction, setLastAction] = useState<"sent" | "draft" | null>(null);
  const [mode, setMode] = useState<Mode>("compose");
  const [error, setError] = useState("");
  const [genError, setGenError] = useState("");

  const naturalRef = useRef<HTMLInputElement>(null);

  // ── Generate body with AI ─────────────────────────────────────────────────
  async function generateBody(prompt: string) {
    if (!prompt.trim()) return;
    setGenerating(true);
    setGenError("");
    try {
      const res = await fetch("/api/generate/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: to.trim(), subject: subject.trim(), prompt: prompt.trim() }),
      });
      const data = (await res.json()) as { body?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Generation failed");
      setBody(data.body ?? "");
      setNaturalText("");
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setGenerating(false);
    }
  }

  // ── Send or save draft ────────────────────────────────────────────────────
  async function handleAction(action: "send" | "draft") {
    if (!to.trim() || !subject.trim() || !body.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, to: to.trim(), subject: subject.trim(), body: body.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      setLastAction(action === "send" ? "sent" : "draft");
      setMode("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  function resetAndClose() {
    setTo(""); setSubject(""); setBody(""); setNaturalText("");
    setLastAction(null); setMode("compose"); setError(""); setGenError("");
    onClose();
  }

  const canSubmit = to.trim() && subject.trim() && body.trim();

  // Quick-generate prompt built from current to/subject fields
  const quickPrompt = [
    to.trim() && `to ${to.trim()}`,
    subject.trim() && `about "${subject.trim()}"`,
    "Write a professional email.",
  ].filter(Boolean).join(" ");

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) resetAndClose(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-hidden flex flex-col p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4 text-[oklch(0.72_0.15_85)]" />
            Compose email
          </DialogTitle>
        </DialogHeader>

        {/* ── Success state ─────────────────────────────────────────────── */}
        {mode === "success" ? (
          <div className="flex flex-col items-center justify-center flex-1 p-10 text-center gap-4">
            <div className="h-12 w-12 rounded-full bg-emerald-100 flex items-center justify-center">
              <Check className="h-6 w-6 text-emerald-600" />
            </div>
            <div>
              <p className="font-medium">
                {lastAction === "sent" ? "Email sent!" : "Draft saved!"}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {lastAction === "sent" ? "To: " : "Draft for: "}
                {to} · {subject}
              </p>
            </div>
            <div className="flex gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setTo(""); setSubject(""); setBody(""); setLastAction(null);
                  setMode("compose"); setError(""); setGenError("");
                }}
              >
                Compose another
              </Button>
              <Button size="sm" onClick={resetAndClose}>Done</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col flex-1 overflow-y-auto">
            {/* ── Compose form ──────────────────────────────────────────── */}
            <div className="flex flex-col gap-4 p-5 flex-1">
              <div className="space-y-1.5">
                <Label htmlFor="email-to" className="text-xs">
                  To <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="email-to"
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="recipient@example.com"
                  className="h-8 text-sm"
                  autoFocus
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="email-subject" className="text-xs">
                  Subject <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="email-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Subject line"
                  className="h-8 text-sm"
                />
              </div>

              <div className="space-y-1.5 flex-1 flex flex-col">
                <div className="flex items-center justify-between">
                  <Label htmlFor="email-body" className="text-xs">
                    Body <span className="text-destructive">*</span>
                  </Label>
                  {/* Quick-generate from existing To/Subject context */}
                  <button
                    type="button"
                    disabled={generating}
                    onClick={() => generateBody(quickPrompt)}
                    className="flex items-center gap-1.5 text-xs font-medium text-[oklch(0.60_0.15_85)] hover:text-[oklch(0.50_0.15_85)] transition-colors disabled:opacity-50"
                    title="Generate body from To + Subject"
                  >
                    {generating ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                    {generating ? "Writing…" : "Write with Basil"}
                  </button>
                </div>
                <Textarea
                  id="email-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={generating ? "Basil is writing…" : "Write your message here, or let Basil draft it below…"}
                  className="flex-1 min-h-[160px] resize-none text-sm"
                  disabled={generating}
                />
              </div>

              {error && <p className="text-xs text-destructive">{error}</p>}

              {/* Action buttons */}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={submitting || generating || !canSubmit}
                  onClick={() => handleAction("send")}
                  className="bg-gradient-to-r from-[oklch(0.72_0.15_85)] to-[oklch(0.78_0.12_85)] hover:from-[oklch(0.78_0.12_85)] hover:to-[oklch(0.82_0.10_85)] text-white gap-1.5"
                >
                  {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Send
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={submitting || generating || !canSubmit}
                  onClick={() => handleAction("draft")}
                  className="gap-1.5"
                >
                  {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                  Save draft
                </Button>
              </div>
            </div>

            {/* ── Basil draft section — prominent card ──────────────────── */}
            <div className="mx-5 mb-5 rounded-xl border border-[oklch(0.72_0.15_85)]/30 bg-[oklch(0.72_0.15_85)]/5 p-4 space-y-3 shrink-0">
              <div className="flex items-center gap-2">
                <div className="flex items-center justify-center h-6 w-6 rounded-md bg-[oklch(0.72_0.15_85)]/15">
                  <Wand2 className="h-3.5 w-3.5 text-[oklch(0.60_0.15_85)]" />
                </div>
                <p className="text-xs font-semibold text-[oklch(0.55_0.15_85)]">
                  Let Basil draft it for you
                </p>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Describe what you want to say and Basil will write the email body directly into the text box above.
              </p>
              <div className="flex gap-2">
                <Input
                  ref={naturalRef}
                  value={naturalText}
                  onChange={(e) => setNaturalText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); generateBody(naturalText); }
                  }}
                  placeholder="e.g. Apologise to Tom for missing the deadline, keep it brief"
                  className="h-8 text-sm bg-background"
                  disabled={generating}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={!naturalText.trim() || generating}
                  onClick={() => generateBody(naturalText)}
                  className="h-8 gap-1.5 shrink-0 bg-[oklch(0.72_0.15_85)] hover:bg-[oklch(0.65_0.15_85)] text-white border-0"
                >
                  {generating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wand2 className="h-3.5 w-3.5" />
                  )}
                  {generating ? "Writing…" : "Draft"}
                </Button>
              </div>
              {genError && <p className="text-xs text-destructive">{genError}</p>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
