"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  MessageCircle,
  Loader2,
  QrCode,
  ShieldAlert,
  Unlink,
  Trash2,
  RefreshCw,
  Search,
  Users,
  UserPlus,
  Check,
  AlertTriangle,
  ChevronRight,
} from "lucide-react";
import type { DumpStatus, SnapshotMessage } from "@/lib/whatsapp/dump-job";
import { loadUserContactsFromServer, updateUserContact, mergeContactsIntoCache, getUserContacts, initialsFor } from "@/lib/user-contacts";
import { emitChange } from "@/lib/sync/channel";
import type { Contact } from "@/lib/contacts-data";

interface LightSnapshot {
  capturedAt: string;
  chatCount: number;
  messageCount: number;
  contactCount: number;
  meJid?: string;
  meName?: string;
  chats: {
    id: string;
    name: string;
    isGroup: boolean;
    unreadCount?: number;
    lastMessageAt?: string;
    lastMessagePreview?: string;
    messageCount: number;
  }[];
}

interface FullChat {
  id: string;
  name: string;
  isGroup: boolean;
  messages: SnapshotMessage[];
}

function relTime(iso?: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function WhatsAppPage() {
  const [status, setStatus] = useState<DumpStatus | null>(null);
  const [snapshot, setSnapshot] = useState<LightSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [chat, setChat] = useState<FullChat | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<{ added: number; updated?: number; unresolved?: number } | null>(null);
  const [profileProgress, setProfileProgress] = useState<{ done: number; total: number } | null>(null);
  const pollRef = useRef<number | null>(null);
  // Track when Start import was clicked so we can show an error if status never
  // leaves "idle" within 10 seconds (indicates the after() task crashed silently).
  const importStartedAtRef = useRef<number | null>(null);
  const [idleTimeoutError, setIdleTimeoutError] = useState(false);
  // Track when the current QR code was received so we can show an expiry countdown.
  // WhatsApp QR codes are valid for ~60 seconds; Baileys issues a new one each time.
  const qrSeenAtRef = useRef<number | null>(null);
  const [qrSecondsLeft, setQrSecondsLeft] = useState<number | null>(null);
  const qrTimerRef = useRef<number | null>(null);
  const lastQrUrlRef = useRef<string | null>(null);
  // Sticky QR: once we receive a QR image, keep rendering it for 30s even if
  // subsequent polls return status without qrDataUrl (e.g. from another instance).
  // Cleared only when we leave awaiting_qr state entirely.
  const [stickyQrUrl, setStickyQrUrl] = useState<string | null>(null);
  // jobId issued by POST /api/whatsapp/dump — passed as ?jobId= to status polls
  // so the server can flag responses from other Vercel instances (jobMismatch).
  const jobIdRef = useRef<string | null>(null);

  const loadSnapshot = useCallback(async () => {
    setSnapshotLoading(true);
    try {
      const res = await fetch("/api/whatsapp/snapshot", { cache: "no-store" });
      const data = await res.json();
      setSnapshot(data.snapshot || null);
    } catch {
      setSnapshot(null);
    } finally {
      setSnapshotLoading(false);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const jobId = jobIdRef.current;
      const url = jobId
        ? `/api/whatsapp/dump/status?jobId=${encodeURIComponent(jobId)}`
        : "/api/whatsapp/dump/status";
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      const s = data.status as DumpStatus;

      // ── Stale-instance guard ────────────────────────────────────────────────
      // The server returns jobMismatch=true when the status comes from an
      // instance that ran a different job (i.e. a stale warm instance returning
      // "idle" or an unrelated run). Skip setStatus to avoid wiping the QR.
      if (data.jobMismatch && jobIdRef.current) {
        return s;
      }

      setStatus(s);

      // Clear the sticky QR once we leave awaiting_qr (scan succeeded or error).
      if (s.state !== "awaiting_qr") {
        setStickyQrUrl(null);
      }

      // Start (or restart) the QR expiry countdown whenever a new QR arrives.
      if (s?.state === "awaiting_qr" && s.qrDataUrl && s.qrDataUrl !== lastQrUrlRef.current) {
        lastQrUrlRef.current = s.qrDataUrl;
        qrSeenAtRef.current = Date.now();
        setStickyQrUrl(s.qrDataUrl); // Latch the image so it persists across stale polls
        if (qrTimerRef.current) window.clearInterval(qrTimerRef.current);
        setQrSecondsLeft(30);
        qrTimerRef.current = window.setInterval(() => {
          const elapsed = Math.floor((Date.now() - (qrSeenAtRef.current ?? Date.now())) / 1000);
          const left = Math.max(0, 30 - elapsed);
          setQrSecondsLeft(left);
          if (left === 0 && qrTimerRef.current) {
            window.clearInterval(qrTimerRef.current);
            qrTimerRef.current = null;
          }
        }, 1000);
      }

      return s;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    loadSnapshot();
    loadStatus();
    // Silently rebuild the compact signal index on every page mount.
    // This bootstraps whatsapp-signal-index.json into BASIL_DATA from whichever
    // warm instance still has the snapshot file on disk — required so
    // generate-profile can find WhatsApp message signal on cold-start instances.
    fetch("/api/whatsapp/rebuild-index", { method: "POST" }).catch((e: unknown) => {
      // best-effort — failure is non-fatal; just log for debugging
      console.warn("[basil-fetch] network_error", { route: "/api/whatsapp/rebuild-index", component: "WhatsAppPage", error: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      if (qrTimerRef.current) window.clearInterval(qrTimerRef.current);
    };
  }, [loadSnapshot, loadStatus]);

  const startImport = useCallback(async () => {
    setImportPreview(null);
    setStickyQrUrl(null);
    setIdleTimeoutError(false);
    lastQrUrlRef.current = null;
    importStartedAtRef.current = Date.now();

    const res = await fetch("/api/whatsapp/dump", { method: "POST" });
    const initData = await res.json() as { status?: DumpStatus; jobId?: string };
    // Store the jobId so subsequent status polls include it for stale-instance filtering.
    jobIdRef.current = initData.jobId ?? null;
    // Apply the POST response immediately — authoritative from the instance that started the dump.
    if (initData.status) setStatus(initData.status);

    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      const s = await loadStatus();
      if (!s) return;

      // If status is still "idle" 10 seconds after clicking Start, the after()
      // task likely crashed silently — show a helpful error rather than a
      // perpetual spinner with no feedback.
      if (
        s.state === "idle" &&
        importStartedAtRef.current !== null &&
        Date.now() - importStartedAtRef.current > 10_000
      ) {
        if (pollRef.current) window.clearInterval(pollRef.current);
        pollRef.current = null;
        jobIdRef.current = null;
        importStartedAtRef.current = null;
        setIdleTimeoutError(true);
        return;
      }

      // Once we see a non-idle state, cancel the idle-timeout check.
      if (s.state !== "idle") {
        importStartedAtRef.current = null;
      }

      if (s.state === "done" || s.state === "error") {
        if (pollRef.current) window.clearInterval(pollRef.current);
        pollRef.current = null;
        jobIdRef.current = null;
        if (s.state === "done") await loadSnapshot();
      }
    }, 1200);
  }, [loadSnapshot, loadStatus]);

  const cancelAndReset = useCallback(async () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    jobIdRef.current = null;
    importStartedAtRef.current = null;
    setIdleTimeoutError(false);
    setStickyQrUrl(null);
    lastQrUrlRef.current = null;
    await fetch("/api/whatsapp/reset", { method: "POST" });
    await loadStatus();
  }, [loadStatus]);

  const deleteSnapshot = useCallback(async () => {
    if (
      !confirm(
        "Delete the WhatsApp snapshot from disk? You'll need to re-scan the QR to import again."
      )
    ) {
      return;
    }
    await fetch("/api/whatsapp/snapshot", { method: "DELETE" });
    setSnapshot(null);
    setSelectedChatId(null);
    setChat(null);
  }, []);

  const importToPersonalContacts = useCallback(async () => {
    setImporting(true);
    setProfileProgress(null);
    try {
      // ── Server-side import ───────────────────────────────────────────────
      // The POST endpoint builds stubs with stable JID-based IDs, writes to
      // the canonical server store, and awaits forceFlushSnapshot() before
      // responding — guaranteeing BASIL_DATA is current before we continue.
      const res = await fetch("/api/whatsapp/import-contacts", {
        method: "POST",
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Import failed (${res.status})`);
      const data = await res.json() as {
        added: number; updated: number; unchanged: number;
        unresolved: number; imported: number; total: number; contacts?: Contact[];
      };

      setImportPreview({ added: data.added, updated: data.updated, unresolved: data.unresolved });
      setImporting(false);

      // ── Seed localStorage directly from POST response ────────────────────
      // The POST body includes the full contact stubs that were just written.
      // Seeding the cache here guarantees contacts are in localStorage BEFORE
      // emitChange fires — so any tab that re-fetches will get a valid merge
      // even if the GET hits a Vercel warm instance that hasn't picked up the
      // new BASIL_DATA yet.
      if (data.contacts?.length) {
        mergeContactsIntoCache(data.contacts);
      }
      emitChange("contacts");

      // Authoritative refresh — await so upgraded names (phone → real name)
      // are in localStorage before we decide which contacts to auto-profile.
      await loadUserContactsFromServer().catch((e: unknown) => {
        // fallback to cache — non-fatal
        console.warn("[basil-fetch] network_error", { route: "loadUserContactsFromServer", component: "WhatsAppPage", error: e instanceof Error ? e.message : String(e) });
      });

      const allContacts = getUserContacts();

      // ── Auto-generate personality profiles (smart — skip existing) ───────
      // Only run for WhatsApp contacts that don't already have a real profile.
      // Skip contacts whose name is still just a phone number — the AI has no
      // signal to work with and will return "—" for every field.
      // Capped at 12, sorted by most-recent interaction, so the most active
      // contacts get profiled first. Re-importing is safe: existing profiles
      // (personality !== "—") are never clobbered.
      const phoneNameRe = /^\+?\d[\d\s\-(). ]{4,}$/;
      const AUTO_PROFILE_LIMIT = 12;
      const toProfile = allContacts
        .filter((c: Contact) =>
          c.tags?.includes("whatsapp") &&
          (!c.personality || c.personality === "—") &&
          !phoneNameRe.test(c.name?.trim() ?? "")
        )
        .sort((a: Contact, b: Contact) => {
          const da = a.lastInteraction ? new Date(a.lastInteraction).getTime() : 0;
          const db = b.lastInteraction ? new Date(b.lastInteraction).getTime() : 0;
          return db - da; // most recent first
        })
        .slice(0, AUTO_PROFILE_LIMIT);

      if (toProfile.length === 0) return;
      setProfileProgress({ done: 0, total: toProfile.length });

      const BATCH = 3;
      let done = 0;
      for (let i = 0; i < toProfile.length; i += BATCH) {
        const batch = toProfile.slice(i, i + BATCH);
        await Promise.all(
          batch.map(async (stub: Contact) => {
            try {
              const pr = await fetch("/api/contacts/generate-profile", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  name: stub.name,
                  phone: stub.phone,
                  directory: "personal",
                }),
              });
              if (pr.ok) {
                const profile = await pr.json();
                if (profile.personality && profile.personality !== "—") {
                  await updateUserContact(stub.id, {
                    personality:       profile.personality,
                    whatMakesThemTick: profile.whatMakesThemTick,
                    watchOut:          profile.watchOut,
                    recentActivity:    profile.recentActivity,
                    activitySource:    profile.activitySource || "WhatsApp",
                  });
                }
              }
            } catch {
              // Profile gen failure is non-fatal — contact already saved
            } finally {
              done++;
              setProfileProgress({ done, total: toProfile.length });
            }
          })
        );
      }

    } catch (e) {
      console.error("Import to personal contacts failed:", e);
      setImportPreview({ added: 0 });
      setImporting(false);
    }
  }, []);

  // Fetch full chat when selection changes
  useEffect(() => {
    if (!selectedChatId) {
      setChat(null);
      return;
    }
    setChatLoading(true);
    fetch(`/api/whatsapp/snapshot?chatId=${encodeURIComponent(selectedChatId)}`, {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.chat) setChat(data.chat);
      })
      .catch(() => setChat(null))
      .finally(() => setChatLoading(false));
  }, [selectedChatId]);

  const filteredChats = useMemo(() => {
    if (!snapshot) return [];
    if (!search.trim()) return snapshot.chats;
    const q = search.toLowerCase();
    return snapshot.chats.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.lastMessagePreview?.toLowerCase().includes(q)
    );
  }, [snapshot, search]);

  const inProgress =
    status &&
    status.state !== "idle" &&
    status.state !== "done" &&
    status.state !== "error";

  // Human-readable label for each state.
  function stateLabel(state: string): string {
    const map: Record<string, string> = {
      awaiting_qr:    "Waiting for QR scan",
      authenticating: "Authenticating…",
      syncing:        "Syncing history",
      saving:         "Saving snapshot",
      disconnecting:  "Unlinking device",
      done:           "Done",
      error:          "Error",
      idle:           "Idle",
    };
    return map[state] ?? state.replace(/_/g, " ");
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-6xl">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <MessageCircle className="h-6 w-6 text-[oklch(0.72_0.15_85)]" />
            WhatsApp
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl leading-relaxed">
            One-shot import: scan a QR, Basil pulls your recent chats, then
            unlinks the device. Snapshot lives on your disk — no live connection
            kept open.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!inProgress && (
            <>
              <Button
                variant={snapshot ? "outline" : "default"}
                size="sm"
                onClick={startImport}
                className={`gap-1.5 ${!snapshot ? "bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)]" : ""}`}
              >
                {snapshot ? (
                  <RefreshCw className="h-3.5 w-3.5" />
                ) : (
                  <QrCode className="h-3.5 w-3.5" />
                )}
                {snapshot ? "Re-import" : "Start import"}
              </Button>
              {snapshot && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={deleteSnapshot}
                  className="gap-1.5 text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete snapshot
                </Button>
              )}
            </>
          )}
        </div>
      </header>

      {/* Safety note — always shown above the action area */}
      <div className="rounded-xl ring-1 ring-amber-500/30 bg-amber-500/5 p-4 flex gap-3 items-start">
        <ShieldAlert className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
        <div className="text-[13px] text-foreground/85 leading-relaxed">
          <p className="font-semibold text-amber-600 mb-1">
            This uses an unofficial WhatsApp protocol.
          </p>
          <p>
            Against WhatsApp ToS and carries a non-zero ban risk. Basil
            disconnects immediately after the dump — your phone will show the
            linked device removed. Safer than keeping a session open, but not
            zero risk. Read-only, no sending.
          </p>
        </div>
      </div>

      {/* ── LOCAL IMPORTER INSTRUCTIONS ── */}
      <div className="rounded-xl ring-1 ring-border bg-muted/30 p-4 space-y-2">
        <p className="text-[13px] font-semibold flex items-center gap-1.5">
          <QrCode className="h-3.5 w-3.5 text-muted-foreground" />
          Recommended: run the importer locally
        </p>
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          The in-browser import is limited by Vercel function timeouts. For large accounts
          or unreliable connections, run the CLI worker on your own machine — it posts the
          snapshot here when done.
        </p>
        <div className="rounded-md bg-background ring-1 ring-border px-3 py-2 font-mono text-[12px] text-foreground/80 space-y-1 select-all">
          <p># Add these to .env.local first:</p>
          <p>WHATSAPP_UPLOAD_TOKEN=&lt;same as server env&gt;</p>
          <p>WHATSAPP_USERNAME=&lt;your Basil username&gt;</p>
          <p>WHATSAPP_UPLOAD_URL=$APP_URL  # e.g. https://basil-app.vercel.app</p>
          <p className="mt-2"># Then run:</p>
          <p>npm run whatsapp:import</p>
        </div>
        <p className="text-[12px] text-muted-foreground">
          The QR code prints in your terminal. Scan it, wait for the sync, and the contacts
          appear here automatically — no browser QR needed.
        </p>
      </div>

      {/* ── PROGRESS / QR ── */}
      {inProgress && status && (
        <Card className="border-[oklch(0.72_0.15_85)]/30">
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 text-[oklch(0.58_0.15_85)] animate-spin" />
              <div>
                <p className="font-semibold">
                  {stateLabel(status.state)}
                </p>
                {status.progressNote && status.state !== "awaiting_qr" && (
                  <p className="text-[13px] text-muted-foreground leading-relaxed mt-0.5">
                    {status.progressNote}
                  </p>
                )}
              </div>
            </div>

            {/* Authenticating — QR was scanned, handshake in progress */}
            {status.state === "authenticating" && (
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                QR scanned — authenticating with WhatsApp. This takes a few seconds…
              </div>
            )}

            {status.state === "awaiting_qr" && (status.qrDataUrl || stickyQrUrl) && (
              <div className="flex flex-col items-center gap-3 py-4">
                {/* Stale QR warning + restart button */}
                {qrSecondsLeft === 0 && (
                  <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-[13px] text-amber-800 flex flex-col items-center gap-2 text-center">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      QR expired — a fresh one should appear shortly. If not, restart the import.
                    </div>
                    <Button size="sm" variant="outline" onClick={startImport} className="gap-1.5 border-amber-400 text-amber-800 hover:bg-amber-100">
                      <RefreshCw className="h-3.5 w-3.5" />
                      Get a new QR
                    </Button>
                  </div>
                )}
                <div className={`relative rounded-xl ring-1 bg-white p-3 shadow-sm transition-all ${qrSecondsLeft === 0 ? "ring-amber-400 opacity-40 grayscale" : "ring-border"}`}>
                  { }
                  <img
                    src={(status.qrDataUrl || stickyQrUrl)!}
                    alt="WhatsApp link QR"
                    className="h-64 w-64"
                  />
                </div>
                {/* Expiry countdown */}
                {qrSecondsLeft !== null && qrSecondsLeft > 0 && (
                  <div className={`text-[12px] font-mono tabular-nums ${qrSecondsLeft <= 10 ? "text-amber-600 font-semibold" : "text-muted-foreground"}`}>
                    Scan within {qrSecondsLeft}s — code refreshes automatically
                  </div>
                )}
                <p className="text-[13px] text-muted-foreground text-center max-w-md leading-relaxed">
                  Open WhatsApp on your phone → <strong>Settings</strong> →{" "}
                  <strong>Linked Devices</strong> → <strong>Link a device</strong> — then scan this code.
                </p>
              </div>
            )}

            {status.state === "awaiting_qr" && !status.qrDataUrl && !stickyQrUrl && (
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <QrCode className="h-4 w-4" />
                Waiting for WhatsApp to issue a QR code…
              </div>
            )}

            {(status.state === "syncing" ||
              status.state === "saving" ||
              status.state === "disconnecting") && (
              <div className="grid grid-cols-3 gap-3">
                <Metric label="Chats" value={status.chatCount} />
                <Metric label="Messages" value={status.messageCount} />
                <Metric label="Contacts" value={status.contactCount} />
              </div>
            )}

            <div className="pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={cancelAndReset}
                className="gap-1.5 text-muted-foreground"
              >
                <Unlink className="h-3.5 w-3.5" />
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── ERROR ── */}
      {status?.state === "error" && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-5 flex gap-3 items-start">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-semibold text-destructive">Import failed</p>
              <p className="text-sm text-muted-foreground mt-1">
                {status.error || "Something went wrong during the import."}
              </p>
              <div className="flex gap-2 mt-3">
                <Button size="sm" onClick={startImport} className="gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5" />
                  Try again
                </Button>
                <Button size="sm" variant="outline" onClick={cancelAndReset}>
                  Reset
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── IDLE TIMEOUT ERROR ── shown when after() task crashes silently */}
      {idleTimeoutError && (
        <Card className="border-amber-400/40 bg-amber-500/5">
          <CardContent className="p-5 flex gap-3 items-start">
            <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-semibold text-amber-700">Import failed to start</p>
              <p className="text-sm text-muted-foreground mt-1">
                The import job did not start within 10 seconds. This is likely a Vercel
                environment limitation — the background task may not support long-running
                WebSocket connections. Use the <strong>local CLI method</strong> shown
                above for a reliable import.
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={cancelAndReset}
                className="mt-3 gap-1.5 border-amber-400 text-amber-700 hover:bg-amber-50"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── INITIAL / EMPTY STATE ── */}
      {!inProgress && !snapshot && !snapshotLoading && status?.state !== "error" && !idleTimeoutError && (
        <Card>
          <CardContent className="p-8 text-center space-y-3">
            <MessageCircle className="h-10 w-10 text-muted-foreground/30 mx-auto" />
            <p className="font-semibold">No WhatsApp snapshot yet</p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
              Link your phone once, Basil pulls the recent history WhatsApp
              pushes on link (typically the last few weeks of chats), then
              unlinks cleanly. Use the <strong>Start import</strong> button above.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── BROWSE SNAPSHOT ── */}
      {snapshot && !inProgress && (
        <>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex gap-4 items-center flex-wrap">
              <Metric label="Chats" value={snapshot.chatCount} />
              <Metric label="Messages" value={snapshot.messageCount} />
              <Metric label="Contacts" value={snapshot.contactCount} />
              <span className="text-[12px] text-muted-foreground">
                Captured {formatTimestamp(snapshot.capturedAt)} · Device unlinked
              </span>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              {importPreview ? (
                <div className="flex flex-col items-end gap-1">
                  {importPreview.added > 0 && (
                    <Badge
                      variant="outline"
                      className="text-[12px] gap-1 border-emerald-400 text-emerald-600 bg-emerald-50"
                    >
                      <Check className="h-3 w-3" />
                      {importPreview.added} new contact{importPreview.added === 1 ? "" : "s"} added
                    </Badge>
                  )}
                  {(importPreview.updated ?? 0) > 0 && (
                    <Badge
                      variant="outline"
                      className="text-[12px] gap-1 border-blue-400 text-blue-600 bg-blue-50"
                      title="Existing contacts whose names, phone numbers, or other fields were updated with richer values from this import."
                    >
                      <Check className="h-3 w-3" />
                      {importPreview.updated} contact{importPreview.updated === 1 ? "" : "s"} updated
                    </Badge>
                  )}
                  {importPreview.added === 0 && (importPreview.updated ?? 0) === 0 && (
                    <Badge
                      variant="outline"
                      className="text-[12px] gap-1 border-zinc-400 text-zinc-600 bg-zinc-50"
                    >
                      <Check className="h-3 w-3" />
                      All contacts already up to date
                    </Badge>
                  )}
                  {(importPreview.unresolved ?? 0) > 0 && (
                    <Badge
                      variant="outline"
                      className="text-[12px] gap-1 border-amber-400 text-amber-700 bg-amber-50"
                      title="These contacts aren't in your phone's address book and didn't send you a message during the import. Re-scan after they message you to get their names."
                    >
                      <AlertTriangle className="h-3 w-3" />
                      {importPreview.unresolved} name{importPreview.unresolved === 1 ? "" : "s"} not yet identified
                    </Badge>
                  )}
                  {profileProgress && (
                    <div className="flex flex-col items-end gap-0.5 w-48">
                      <span className="text-xs text-muted-foreground">
                        {profileProgress.done < profileProgress.total
                          ? `Profiling ${profileProgress.done}/${profileProgress.total}…`
                          : `${profileProgress.total} profiles generated ✓`}
                      </span>
                      <div className="w-full h-1 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full bg-[oklch(0.72_0.15_85)] rounded-full transition-all duration-300"
                          style={{ width: `${Math.round((profileProgress.done / profileProgress.total) * 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={importToPersonalContacts}
                  disabled={importing}
                  className="gap-1.5"
                  title="Import contacts and auto-generate personality profiles"
                >
                  {importing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <UserPlus className="h-3.5 w-3.5" />
                  )}
                  {importing ? "Importing…" : "Add to Personal contacts"}
                </Button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[300px_1fr] gap-4 min-h-[500px]">
            {/* Chat list */}
            <Card className="overflow-hidden">
              <div className="p-3 border-b border-border">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search chats…"
                    className="pl-9 h-9"
                  />
                </div>
              </div>
              <div className="max-h-[560px] overflow-y-auto">
                {filteredChats.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground text-center">
                    No chats match.
                  </p>
                ) : (
                  <ul className="divide-y divide-border/60">
                    {filteredChats.map((c) => {
                      const selected = c.id === selectedChatId;
                      return (
                        <li key={c.id}>
                          <button
                            onClick={() => setSelectedChatId(c.id)}
                            className={`w-full text-left px-3 py-2.5 flex gap-2 items-start hover:bg-accent/40 transition-colors ${
                              selected ? "bg-[oklch(0.72_0.15_85)]/10" : ""
                            }`}
                          >
                            <div
                              className={`h-9 w-9 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0 ${
                                c.isGroup ? "bg-violet-500" : "bg-emerald-600"
                              }`}
                            >
                              {c.isGroup ? (
                                <Users className="h-4 w-4" />
                              ) : (
                                initialsFor(c.name)
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-medium truncate flex-1">
                                  {c.name}
                                </p>
                                <span className="text-xs text-muted-foreground shrink-0">
                                  {relTime(c.lastMessageAt)}
                                </span>
                              </div>
                              <p className="text-[12px] text-muted-foreground truncate">
                                {c.lastMessagePreview || "—"}
                              </p>
                            </div>
                            {selected && (
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground mt-1.5 shrink-0" />
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </Card>

            {/* Chat view */}
            <Card className="overflow-hidden flex flex-col">
              {!selectedChatId ? (
                <div className="flex-1 flex items-center justify-center p-8 text-center">
                  <div>
                    <MessageCircle className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
                    <p className="text-sm text-muted-foreground">
                      Pick a chat on the left to read its history.
                    </p>
                  </div>
                </div>
              ) : chatLoading ? (
                <div className="p-6 space-y-3">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                  <Skeleton className="h-4 w-3/5" />
                </div>
              ) : chat ? (
                <>
                  <div className="px-5 py-3 border-b border-border flex items-center gap-2">
                    {chat.isGroup ? (
                      <Users className="h-4 w-4 text-violet-500" />
                    ) : (
                      <MessageCircle className="h-4 w-4 text-emerald-600" />
                    )}
                    <p className="font-semibold text-sm">{chat.name}</p>
                    <span className="text-[12px] text-muted-foreground ml-auto font-mono tabular-nums">
                      {chat.messages.length} msg
                    </span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-5 space-y-3 max-h-[560px]">
                    {chat.messages.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No messages in this chat.
                      </p>
                    ) : (
                      chat.messages.map((m) => (
                        <div
                          key={m.id}
                          className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}
                        >
                          <div
                            className={`max-w-[80%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
                              m.fromMe
                                ? "bg-[oklch(0.72_0.15_85)]/20 text-foreground"
                                : "bg-muted/60 text-foreground/90"
                            }`}
                          >
                            {!m.fromMe && (
                              <p className="text-xs font-semibold text-[oklch(0.58_0.15_85)] mb-0.5">
                                {chat.isGroup ? (m.authorName || "Unknown") : chat.name}
                              </p>
                            )}
                            {m.text ? (
                              <p className="whitespace-pre-wrap break-words">
                                {m.text}
                              </p>
                            ) : (
                              <p className="italic text-muted-foreground">
                                {m.note || `(${m.type})`}
                              </p>
                            )}
                            <p className="text-xs text-muted-foreground mt-1 font-mono tabular-nums">
                              {m.timestamp && formatTimestamp(m.timestamp)}
                            </p>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </>
              ) : (
                <div className="p-6 text-sm text-muted-foreground">
                  Couldn&apos;t load chat.
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      <span className="text-[12px] text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
    </div>
  );
}
