"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useDomainSync } from "@/lib/sync/use-domain-sync";
import { contacts as seedContacts, type Contact, type ContactDirectory } from "@/lib/contacts-data";
import {
  getUserContacts,
  loadUserContactsFromServer,
  addUserContact,
  updateUserContact,
  patchContactInCache,
  getDismissedSuggestionIds,
  dismissSuggestion,
  pickAvatarColor,
  initialsFor,
} from "@/lib/user-contacts";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { useContactPhotos } from "@/lib/hooks/use-contact-photos";
import { Search, Mail, MapPin, Users, Brain, CheckSquare, AlertTriangle, Activity, Flame, RefreshCw, Loader2, Wifi, Sparkles, Plus, X, Phone, Briefcase, Home, ArrowRightLeft, MessageCircle, Wand2, Check, ChevronLeft, ChevronDown, ChevronUp, Pencil } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Textarea } from "@/components/ui/textarea";
import {
  getAllOverrides,
  loadOverridesFromServer,
  setOverride,
  clearOverride,
  type ProfileOverride,
} from "@/lib/contact-profile-overrides";

import type { ContactSuggestion } from "@/lib/types/contact";
import { usePersistentDraft } from "@/lib/hooks/use-persistent-draft";
import { DraftSavedIndicator } from "@/components/ui/draft-saved-indicator";
import { scopedKey } from "@/lib/session-user";

// ── Per-contact draft store ───────────────────────────────────────────────────
// CLASSIFICATION: sage-contact-draft-{id} → LOCAL-ONLY (transient in-progress
// work; keyed by contact ID; cleared on explicit save or discard; never promoted
// Persists genNotes, the generated preview, extracted canonical fields, and
// panel-open state across contact-list navigation and tab switches.
// usePersistentDraft handles load/save/clear with username scoping.

interface ContactDraft {
  genNotes: string;
  genOpen: boolean;
  preview: ProfileOverride | null;
  /** Structured fields the AI extracted from context notes.
   *  Applied to the canonical Contact record alongside the prose override on save. */
  canonicalFields: Partial<Contact> | null;
}

const EMPTY_DRAFT: ContactDraft = {
  genNotes: "",
  genOpen: false,
  preview: null,
  canonicalFields: null,
};

function ContactList({
  contacts: list,
  selected,
  onSelect,
  photos = {},
}: {
  contacts: Contact[];
  selected: string | null;
  onSelect: (id: string) => void;
  photos?: Record<string, string>;
}) {
  return (
    <div className="space-y-1">
      {list.map((c) => (
        <button
          key={c.id}
          onClick={() => onSelect(c.id)}
          className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
            selected === c.id
              ? "bg-[oklch(0.72_0.15_85)]/10 border border-[oklch(0.72_0.15_85)]/30"
              : "hover:bg-accent/50 border border-transparent"
          }`}
        >
          <ContactAvatar
            initials={c.initials}
            color={c.color}
            photoUrl={photos[c.email?.toLowerCase() ?? ""]}
            className="h-8 w-8 shrink-0"
            fallbackClassName="text-xs"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <p className="text-sm font-medium truncate">{c.name}</p>
              {c._isSeedData && (
                <span className="shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-muted text-muted-foreground border border-border/60">
                  SAMPLE
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground truncate">{c.title}</p>
          </div>
          <Badge
            variant="outline"
            className={`text-[12px] shrink-0 ${
              c.type === "internal"
                ? "border-blue-400 text-blue-600"
                : "border-amber-400 text-amber-600"
            }`}
          >
            {c.type === "internal" ? "internal" : "external"}
          </Badge>
        </button>
      ))}
    </div>
  );
}

function ContactDetail({
  contact,
  photoUrl,
  liveItems,
  liveSources,
  lastInteraction,
  zoomCadence,
  zoomMeetingCount,
  canMove,
  isUserContact,
  onMove,
  onRename,
  override,
  onSaveOverride,
  onClearOverride,
  onContactUpdated,
}: {
  contact: Contact;
  photoUrl?: string;
  liveItems: string[];
  liveSources: string[];
  lastInteraction?: string;
  zoomCadence?: string | null;
  zoomMeetingCount?: number;
  /** True if this is a user-added contact that can be reassigned / renamed. */
  canMove: boolean;
  isUserContact: boolean;
  onMove: (target: ContactDirectory) => void;
  /** Called after a successful rename so the parent can refresh the list. */
  onRename: (newName: string) => void;
  override?: ProfileOverride;
  onSaveOverride: (patch: ProfileOverride) => void;
  onClearOverride: () => void;
  /** Called after canonical Contact fields are updated so the parent can refresh. */
  onContactUpdated: () => void;
}) {
  const daysSince = lastInteraction
    ? Math.floor((Date.now() - new Date(lastInteraction).getTime()) / 86400000)
    : null;
  const otherDirectory: ContactDirectory =
    contact.directory === "work" ? "personal" : "work";

  // ── Generator state ────────────────────────────────────────────────────────
  // STATE MODEL:
  //   genNotes        → LOCAL DRAFT (durable: survives tab switches)
  //   preview         → LOCAL DRAFT (durable: AI-generated prose, pending acceptance)
  //   canonicalFields → LOCAL DRAFT (durable: structured fields extracted from notes)
  //   genOpen         → LOCAL DRAFT (durable: whether the context panel is visible)
  //   genError        → EPHEMERAL  (never persisted — re-run to refresh)
  //   genLoading      → EPHEMERAL  (in-flight flag)
  //
  // Draft is persisted to localStorage keyed by contact.id via the effect below.
  // usePersistentDraft handles load/save/clear for the generation panel.
  // entityId = contact.id ensures each contact has its own draft bucket.
  const {
    draft: contactDraft,
    setDraft: setContactDraft,
    clearDraft: clearContactDraft,
    draftSaved: genDraftSaved,
  } = usePersistentDraft<ContactDraft>("contact-gen", {
    defaultValue: EMPTY_DRAFT,
    entityId: contact.id,
  });

  const genOpen      = contactDraft.genOpen;
  const genNotes     = contactDraft.genNotes;
  const preview      = contactDraft.preview;
  const canonicalFields = contactDraft.canonicalFields;

  const setGenOpen        = (v: boolean)                                 => setContactDraft((d) => ({ ...d, genOpen: v }));
  const setGenNotes       = (v: string)                                  => setContactDraft((d) => ({ ...d, genNotes: v }));
  const setPreview        = (v: ProfileOverride | null)                  => setContactDraft((d) => ({ ...d, preview: v }));
  const setCanonicalFields = (v: Partial<Contact> | null)                => setContactDraft((d) => ({ ...d, canonicalFields: v }));

  const [genLoading, setGenLoading] = useState(false);
  const [genError, setGenError] = useState("");

  // Save-to-server state — explicit feedback for every stage of accept flow.
  // "idle"   → no in-progress save
  // "saving" → awaiting server response (button disabled, spinner shown)
  // "saved"  → server confirmed; draft cleared; resets to "idle" after 3 s
  // "error"  → server returned an error; draft preserved so user can retry
  type SaveState = "idle" | "saving" | "saved" | "error";
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");

  // Inline name editing — only for user-added contacts.
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(contact.name);
  const [nameSaving, setNameSaving] = useState(false);

  async function saveName() {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === contact.name) { setEditingName(false); return; }
    setNameSaving(true);
    await updateUserContact(contact.id, { name: trimmed });
    onRename(trimmed);
    setEditingName(false);
    setNameSaving(false);
  }

  // Clear ephemeral UI state when contact changes (usePersistentDraft handles draft reload).
  // contact.name dep keeps nameInput current after a rename.
  useEffect(() => {
    setGenError("");
    setGenLoading(false);
    setEditingName(false);
    setNameInput(contact.name);
  }, [contact.id, contact.name]);  

  async function generateProfile() {
    setGenLoading(true);
    setGenError("");
    setPreview(null);
    try {
      const res = await fetch("/api/contacts/generate-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: contact.name,
          email: contact.email,
          phone: contact.phone,
          directory: contact.directory,
          notes: genNotes.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = (await res.json()) as ProfileOverride & {
        error?: string;
        /** Structured fields explicitly stated in the user's notes. */
        canonicalFields?: Partial<Contact>;
      };
      if (data.error) throw new Error(data.error);

      // Store any structured field extractions — applied to the canonical
      // Contact record when the user accepts the preview (see acceptPreview).
      const extracted = data.canonicalFields ?? {};
      const hasCanonical = Object.values(extracted).some(
        (v) => v && typeof v === "string" && (v as string).trim()
      );
      setCanonicalFields(hasCanonical ? extracted : null);

      setPreview({
        personality: data.personality,
        whatMakesThemTick: data.whatMakesThemTick,
        watchOut: data.watchOut,
        recentActivity: data.recentActivity,
        activitySource: data.activitySource,
        summary: data.summary,
        generatedAt: new Date().toISOString(),
      });
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setGenLoading(false);
    }
  }

  async function acceptPreview() {
    if (!preview || saveState === "saving") return;
    setSaveState("saving");
    setSaveError("");

    try {
      if (isUserContact) {
        // ── User contact: single atomic PATCH ────────────────────────────────
        // Merge profile prose fields + AI-extracted canonical fields into one
        // request so there is exactly one failure point and one server write.
        const patch: Partial<Contact> = {};

        // Profile prose fields (skip if empty / undefined).
        const addStr = (key: keyof Contact, val: string | undefined) => {
          if (val?.trim()) (patch as Record<string, string>)[key as string] = val.trim();
        };
        addStr("personality", preview.personality);
        addStr("whatMakesThemTick", preview.whatMakesThemTick);
        addStr("watchOut", preview.watchOut);
        addStr("recentActivity", preview.recentActivity);
        addStr("activitySource", preview.activitySource);
        if (preview.generatedAt) patch.generatedAt = preview.generatedAt;
        if (preview.summary?.trim()) patch.profileSummary = preview.summary.trim();

        // Canonical fields extracted from notes (e.g. name, title, company).
        if (canonicalFields) {
          for (const [key, value] of Object.entries(canonicalFields)) {
            if (value && typeof value === "string" && value.trim()) {
              (patch as Record<string, string>)[key] = value.trim();
            }
          }
        }

        const res = await fetch(`/api/contacts/user/${contact.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });

        if (!res.ok) {
          let errMsg = `Server error (${res.status})`;
          try {
            const json = await res.json() as { error?: string };
            if (json.error) errMsg = json.error;
          } catch (e) {
            console.error("[basil-fetch] json_parse_error", { route: `/api/contacts/user/${contact.id}`, status: res.status, component: "ContactsPage", error: e instanceof Error ? e.message : String(e) });
          }
          throw new Error(errMsg);
        }

        // Update localStorage cache with the authoritative server record so
        // a page reload shows the saved state, not a stale optimistic write.
        const { contact: serverContact } = await res.json() as { contact: Contact };
        patchContactInCache(serverContact);
        onContactUpdated(); // refresh React state from cache
      } else {
        // ── Seed contact: profile override only ───────────────────────────────
        // Seed records are immutable; store generated fields in the overrides layer.
        const res = await fetch(`/api/contacts/overrides/${contact.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(preview),
        });

        if (!res.ok) {
          let errMsg = `Server error (${res.status})`;
          try {
            const json = await res.json() as { error?: string };
            if (json.error) errMsg = json.error;
          } catch (e) {
            console.error("[basil-fetch] json_parse_error", { route: `/api/contacts/overrides/${contact.id}`, status: res.status, component: "ContactsPage", error: e instanceof Error ? e.message : String(e) });
          }
          throw new Error(errMsg);
        }

        // Server confirmed — update local override cache so the UI reflects
        // the saved state immediately (onSaveOverride does optimistic + server).
        onSaveOverride(preview);
      }

      // ── Success ───────────────────────────────────────────────────────────
      setSaveState("saved");
      clearContactDraft(); // clears the scoped localStorage key + resets to EMPTY_DRAFT
      // Reset badge after 3 s so subsequent regenerations start clean.
      setTimeout(() => setSaveState("idle"), 3000);
    } catch (e) {
      // ── Failure ───────────────────────────────────────────────────────────
      // Draft is intentionally preserved so the user can retry without re-generating.
      setSaveState("error");
      setSaveError(e instanceof Error ? e.message : "Save failed — please try again");
    }
  }
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <ContactAvatar
          initials={contact.initials}
          color={contact.color}
          photoUrl={photoUrl}
          className="h-14 w-14 shrink-0"
          fallbackClassName="text-lg font-semibold"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              {/* Inline name edit — only for user-added contacts */}
              {editingName ? (
                <div className="flex items-center gap-1.5">
                  <input
                    autoFocus
                    value={nameInput}
                    onChange={e => setNameInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditingName(false); }}
                    className="text-xl font-semibold bg-transparent border-b-2 border-[oklch(0.72_0.15_85)] outline-none w-48"
                  />
                  <button onClick={saveName} disabled={nameSaving} className="text-emerald-600 hover:text-emerald-700 disabled:opacity-50">
                    <Check className="h-4 w-4" />
                  </button>
                  <button onClick={() => setEditingName(false)} className="text-muted-foreground hover:text-foreground">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 group">
                  <h2 className="text-xl font-semibold">{contact.name}</h2>
                  {contact._isSeedData && (
                    <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-muted text-muted-foreground border border-border/60">
                      SAMPLE
                    </span>
                  )}
                  {isUserContact && (
                    <button
                      onClick={() => { setNameInput(contact.name); setEditingName(true); }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                      title="Edit name"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
              <p className="text-sm text-[oklch(0.72_0.15_85)]">{contact.title}</p>
              <p className="text-sm text-muted-foreground">{contact.company}</p>
              {contact.phone && (
                <p className="text-sm text-muted-foreground flex items-center gap-1 mt-0.5">
                  <Phone className="h-3 w-3 shrink-0" />
                  {contact.phone}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge
                variant="outline"
                className="text-[12px] gap-1 border-[oklch(0.72_0.15_85)]/40 text-[oklch(0.58_0.15_85)]"
              >
                {contact.directory === "work" ? (
                  <Briefcase className="h-3 w-3" />
                ) : (
                  <Home className="h-3 w-3" />
                )}
                {contact.directory}
              </Badge>
              {canMove && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onMove(otherDirectory)}
                  className="gap-1"
                  title={`Move to ${otherDirectory} directory`}
                >
                  <ArrowRightLeft className="h-3 w-3" />
                  Move to {otherDirectory}
                </Button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground flex-wrap">
            {contact.email && (
              <span className="flex items-center gap-1">
                <Mail className="h-3 w-3" /> {contact.email}
              </span>
            )}
            {contact.phone && (
              <span className="flex items-center gap-1">
                <Phone className="h-3 w-3" /> {contact.phone}
              </span>
            )}
            {contact.location && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" /> {contact.location}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {contact.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-[12px] border-[oklch(0.72_0.15_85)]/30 text-[oklch(0.72_0.15_85)]">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      </div>

      {/* Basil profile generator */}
      <div className="rounded-xl ring-1 ring-[oklch(0.72_0.15_85)]/25 bg-[oklch(0.72_0.15_85)]/[0.04] p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-semibold flex items-center gap-1.5">
              <Wand2 className="h-3.5 w-3.5 text-[oklch(0.58_0.15_85)]" />
              Personality profile
            </p>
            <p className="text-[12px] text-muted-foreground leading-relaxed mt-0.5">
              {override?.generatedAt ? (
                <>
                  Last regenerated by Basil ·{" "}
                  {new Date(override.generatedAt).toLocaleString("en-GB", {
                    timeZone: "Europe/London",
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {override.summary ? ` · ${override.summary}` : ""}
                </>
              ) : contact.directory === "personal" ? (
                "Add a few notes and Basil will draft a profile. Friends and family rarely appear in Gmail or Slack — your notes are the richest signal."
              ) : (
                "Basil will pull every email, Slack thread, and Zoom summary tied to this person, then draft the profile fields below. Add your own notes to colour what she sees."
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {override?.generatedAt && (
              <Button
                size="xs"
                variant="outline"
                onClick={onClearOverride}
                className="gap-1"
                title="Revert to original profile"
              >
                <RefreshCw className="h-3 w-3" />
                Revert
              </Button>
            )}
            {!genOpen && (
              <Button
                size="sm"
                onClick={() => setGenOpen(true)}
                className="gap-1.5 bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)]"
              >
                <Wand2 className="h-3.5 w-3.5" />
                {override?.generatedAt ? "Regenerate" : "Generate profile"}
              </Button>
            )}
          </div>
        </div>

        {genOpen && !preview && (
          <div className="space-y-2">
            <Textarea
              value={genNotes}
              onChange={(e) => setGenNotes(e.target.value)}
              placeholder={
                contact.directory === "personal"
                  ? "How you met, what they care about, anything Basil should know…"
                  : "Optional: add context Basil won't find in Gmail / Slack / Zoom (how they prefer to be approached, things to remember, etc.)"
              }
              rows={3}
              disabled={genLoading}
              className="min-h-20"
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={generateProfile}
                disabled={
                  genLoading ||
                  (contact.directory === "personal" && !genNotes.trim())
                }
                className="gap-1.5 bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)]"
              >
                {genLoading ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Reading signal…
                  </>
                ) : (
                  <>
                    <Wand2 className="h-3.5 w-3.5" />
                    Draft profile
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  // Cancel = abandon in-progress work entirely.
                  clearContactDraft();
                  setGenError("");
                }}
                disabled={genLoading}
              >
                Cancel
              </Button>
              <DraftSavedIndicator saved={genDraftSaved} className="ml-1" />
              {contact.directory === "personal" && !genNotes.trim() && (
                <span className="text-[12px] text-muted-foreground">
                  Add notes to generate a personal profile
                </span>
              )}
            </div>
            {genError && (
              <p className="text-[12px] text-destructive">{genError}</p>
            )}
          </div>
        )}

        {preview && (
          <div className="space-y-3">
            {/* Canonical field extractions — contact details the AI pulled from notes */}
            {canonicalFields && Object.values(canonicalFields).some((v) => v) && (
              <div className="rounded-lg bg-emerald-500/10 ring-1 ring-emerald-500/20 p-3 space-y-1.5">
                <p className="text-[12px] font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                  <Check className="h-3 w-3" />
                  Contact details to update on save
                </p>
                {(Object.entries(canonicalFields) as [string, string | undefined][]).map(([key, value]) => {
                  if (!value) return null;
                  const labels: Record<string, string> = {
                    name: "Name", title: "Role", company: "Company",
                    location: "Location", email: "Email", phone: "Phone",
                  };
                  return (
                    <p key={key} className="text-xs text-foreground/80">
                      <span className="text-muted-foreground">{labels[key] ?? key}:</span>{" "}
                      <span className="font-medium">{value}</span>
                    </p>
                  );
                })}
              </div>
            )}

            {/* Prose preview */}
            <div className="rounded-lg bg-background/60 ring-1 ring-border p-3 space-y-3">
              {(
                [
                  ["Personality", preview.personality],
                  ["What makes them tick", preview.whatMakesThemTick],
                  ["Watch out", preview.watchOut],
                  ["Recent activity", preview.recentActivity],
                  ["Activity source", preview.activitySource],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <p className="text-[12px] font-semibold tracking-widest uppercase text-[oklch(0.58_0.15_85)]">
                    {label}
                  </p>
                  <p className="text-sm leading-relaxed text-foreground/90 mt-1 whitespace-pre-line">
                    {value}
                  </p>
                </div>
              ))}
              {preview.summary && (
                <p className="text-[12px] text-muted-foreground pt-2 border-t border-border/60">
                  {preview.summary}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  size="sm"
                  onClick={acceptPreview}
                  disabled={saveState === "saving"}
                  className="gap-1.5 bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)] disabled:opacity-70"
                >
                  {saveState === "saving" ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" />Saving to Basil…</>
                  ) : saveState === "saved" ? (
                    <><Check className="h-3.5 w-3.5" />Saved</>
                  ) : (
                    <><Check className="h-3.5 w-3.5" />Save profile</>
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saveState === "saving"}
                  onClick={() => {
                    // Discard preview only — keep notes so user can iterate.
                    setPreview(null);
                    setCanonicalFields(null);
                    setSaveState("idle");
                    setSaveError("");
                  }}
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={generateProfile}
                  disabled={genLoading || saveState === "saving"}
                  className="gap-1.5"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Try again
                </Button>
              </div>
              {saveState === "error" && (
                <p className="text-[12px] text-destructive bg-destructive/10 rounded px-2 py-1">
                  {saveError}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="personality" className="gap-1">
            <Brain className="h-3.5 w-3.5" /> Personality
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold tracking-widest uppercase text-[oklch(0.72_0.15_85)]">
                Relationship
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed">{contact.relationship}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold tracking-widest uppercase text-[oklch(0.72_0.15_85)]">
                Company Context
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed">{contact.companyContext}</p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="personality" className="space-y-4 mt-4">
          <Card className="border-l-4 border-l-[oklch(0.72_0.15_85)]">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold tracking-widest uppercase flex items-center gap-1.5">
                <Brain className="h-3.5 w-3.5 text-[oklch(0.72_0.15_85)]" /> Personality
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed">{contact.personality}</p>
            </CardContent>
          </Card>
          <Card className="border-l-4 border-l-emerald-500">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold tracking-widest uppercase flex items-center gap-1.5">
                <CheckSquare className="h-3.5 w-3.5 text-emerald-500" /> What Makes Them Tick
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed">{contact.whatMakesThemTick}</p>
            </CardContent>
          </Card>
          <Card className="border-l-4 border-l-amber-500">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold tracking-widest uppercase flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> Watch Out
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed">{contact.watchOut}</p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activity" className="space-y-4 mt-4">
          {/* Live activity — pulled from Calendar, Gmail, Slack, Docs. */}
          {liveItems.length > 0 && (
            <Card className="border-l-4 border-l-emerald-500">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold tracking-widest uppercase text-emerald-600 flex items-center gap-1.5">
                  <Wifi className="h-3.5 w-3.5" /> Live Activity
                  {lastInteraction && daysSince !== null && (
                    <span className="text-[12px] font-normal text-muted-foreground normal-case tracking-normal ml-1">
                      · last {daysSince === 0 ? "today" : daysSince === 1 ? "yesterday" : `${daysSince}d ago`}
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {liveItems.slice(0, 6).map((item, i) => (
                    <li key={i} className="flex gap-2 leading-relaxed">
                      <span className="text-emerald-500 mt-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                      <span className="text-foreground/90">{item}</span>
                    </li>
                  ))}
                </ul>
                {liveSources.length > 0 && (
                  <p className="text-[12px] text-muted-foreground mt-3 flex items-center gap-1.5">
                    <Activity className="h-3 w-3" /> Sources: {liveSources.join(", ")}
                  </p>
                )}
                {zoomCadence && (
                  <p className="text-[12px] text-muted-foreground mt-1.5 flex items-center gap-1.5">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />
                    Zoom cadence: <span className="font-medium text-foreground">{zoomCadence}</span>
                    {zoomMeetingCount && zoomMeetingCount > 0 && (
                      <span className="text-muted-foreground/60">({zoomMeetingCount} meeting{zoomMeetingCount !== 1 ? "s" : ""} / 30d)</span>
                    )}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Hardcoded narrative — context for what was happening last time the
              persona was authored. Shown as a historical note alongside live data. */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold tracking-widest uppercase text-[oklch(0.72_0.15_85)]">
                {liveItems.length > 0 ? "Background & recent history" : "Recent Activity"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed">{contact.recentActivity}</p>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Activity className="h-3 w-3" /> Persona source: {contact.activitySource}
          </p>
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface ContactActivityItem {
  contactId: string;
  name: string;
  lastInteraction: string | null;
  sources: string[];
  recentItems: string[];
  zoomMeetingCount?: number;
  zoomCadence?: string | null;
  totalInteractionCount?: number;
}

export default function ContactsPage() {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [activeDirectory, setActiveDirectory] = useState<ContactDirectory>("work");
  /** Domain extracted from the authenticated user's own email address (e.g. "acme.com").
   *  Used to classify suggested contacts as internal vs external without hardcoding a domain. */
  const [selfEmailDomain, setSelfEmailDomain] = useState("");
  const [liveActivity, setLiveActivity] = useState<ContactActivityItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [activityFetchedAt, setActivityFetchedAt] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);
  const [userContacts, setUserContacts] = useState<Contact[]>([]);
  const [overrides, setOverrides] = useState<Record<string, ProfileOverride>>({});
  const [healthCollapsed, setHealthCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("sage-health-collapsed") === "true"; } catch { return false; }
  });

  // Merge seed + user-added contacts — this is the effective "all contacts" list.
  const contacts = useMemo<Contact[]>(
    () => [...seedContacts, ...userContacts],
    [userContacts]
  );

  // Batch-fetch headshots for all contacts (Gravatar, falls back to initials)
  const contactEmails = useMemo(
    () => contacts.map((c) => c.email ?? "").filter(Boolean),
    [contacts]
  );
  const photos = useContactPhotos(contactEmails);

  // Slice by directory — every view on this page reads from here.
  const directoryContacts = useMemo<Contact[]>(
    () => contacts.filter((c) => c.directory === activeDirectory),
    [contacts, activeDirectory]
  );

  const counts = useMemo(
    () => ({
      work: contacts.filter((c) => c.directory === "work").length,
      personal: contacts.filter((c) => c.directory === "personal").length,
    }),
    [contacts]
  );

  const refreshSuggestions = useCallback(async () => {
    setSuggestLoading(true);
    try {
      const res = await fetch("/api/contacts/suggest");
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setSuggestions(data.suggestions || []);
      localStorage.setItem(scopedKey("contact-suggestions"), JSON.stringify(data));
    } catch (e) {
      console.error("Suggestion refresh failed:", e);
    } finally {
      setSuggestLoading(false);
    }
  }, []);

  const refreshActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const res = await fetch("/api/contacts/activity");
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setLiveActivity(data.activity || []);
      setIsLive(true);
      setActivityFetchedAt(data.fetchedAt ?? new Date().toISOString());
      localStorage.setItem(scopedKey("contact-activity"), JSON.stringify(data));
    } catch (e) {
      console.error("Activity refresh failed:", e);
    } finally {
      setActivityLoading(false);
    }
  }, []);

  // Load cached activity + user contacts + dismissed suggestions on mount.
  // User contacts and overrides have a two-phase load:
  //   1. Immediate: sync read from localStorage cache (fast first render)
  //   2. Authoritative: async fetch from server store (corrects any stale cache)
  //
  // sage-contact-activity / sage-contact-suggestions
  // CLASSIFICATION: disposable UX convenience — inferred from live Gmail/Slack
  // signals; refreshed on each page mount.  Not assistant truth.  Clearing
  // these keys means the next mount re-fetches from source rather than using
  // a stale cache.
  useEffect(() => {
    const AUTO_REFRESH_MS = 30 * 60 * 1000; // 30 minutes

    const cached = localStorage.getItem(scopedKey("contact-activity"));
    let needsRefresh = true;
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        setLiveActivity(parsed.activity || []);
        setIsLive(true);
        if (parsed.fetchedAt) {
          setActivityFetchedAt(parsed.fetchedAt);
          const age = Date.now() - new Date(parsed.fetchedAt).getTime();
          needsRefresh = age > AUTO_REFRESH_MS;
        }
      } catch { /* ignore */ }
    }

    // Refresh on mount if no cache or cache is stale (>30 min old)
    if (needsRefresh) {
      refreshActivity();
    }

    // Auto-refresh every 30 minutes
    const autoRefreshInterval = window.setInterval(() => {
      refreshActivity();
    }, AUTO_REFRESH_MS);

    // Phase 1 — instant render from local cache
    setUserContacts(getUserContacts());
    setDismissedIds(getDismissedSuggestionIds());
    setOverrides(getAllOverrides());

    // Phase 2 — authoritative server data (runs migration on first visit)
    loadUserContactsFromServer().then(setUserContacts);
    loadOverridesFromServer().then(setOverrides);

    // Fetch the authenticated user's own email so we can derive their org domain
    // for internal/external contact classification — no hardcoded domain needed.
    fetch("/api/settings")
      .then((r) => r.ok ? r.json() : null)
      .then((s: { email?: string } | null) => {
        if (s?.email) {
          const domain = s.email.split("@")[1]?.toLowerCase() ?? "";
          if (domain) setSelfEmailDomain(domain);
        }
      })
      .catch(() => { /* silently ignore — classification falls back to "external" */ });

    // Also auto-load a cached suggestion set so the strip doesn't come up empty.
    const cachedSugg = localStorage.getItem(scopedKey("contact-suggestions"));
    if (cachedSugg) {
      try {
        const parsed = JSON.parse(cachedSugg);
        setSuggestions(parsed.suggestions || []);
      } catch { /* ignore */ }
    }

    return () => {
      window.clearInterval(autoRefreshInterval);
    };
  }, [refreshActivity]);

  // Subscribe to the contacts domain so changes from other surfaces (or other
  // tabs) trigger an activity refresh here. Also re-load user contacts when
  // the domain changes so the list stays consistent across tabs.
  // Must be declared before the callbacks below that reference notifyContacts.
  const notifyContacts = useDomainSync("contacts", () => {
    refreshActivity();
    loadUserContactsFromServer().then(setUserContacts);
  });

  const handleAddSuggestion = useCallback(async (s: ContactSuggestion) => {
    const stub: Contact = {
      id: s.id,
      name: s.displayName,
      initials: initialsFor(s.displayName),
      color: pickAvatarColor(s.displayName),
      title: "Unknown — set role",
      company: s.email?.split("@")[1]?.split(".")[0]?.replace(/\b\w/g, (c) => c.toUpperCase()) || "Unknown",
      email: s.email,
      tags: ["auto-added"],
      status: "pending",
      type: (selfEmailDomain && s.email?.toLowerCase().endsWith(`@${selfEmailDomain}`)) ? "internal" : "external",
      // Suggestions come from Gmail/Slack signal — always work by default.
      // User can re-assign via the "Move to Personal" action on the detail.
      directory: "work",
      relationship: `Added from recent ${s.signalSources.join(" + ")} signal. Fill in context.`,
      companyContext: "—",
      personality: `Observed ${s.emailCount} email${s.emailCount === 1 ? "" : "s"} and ${s.slackCount} Slack message${s.slackCount === 1 ? "" : "s"} recently. Sample: "${s.sample}"`,
      whatMakesThemTick: "—",
      watchOut: "—",
      recentActivity: s.sample,
      activitySource: s.signalSources.join(", "),
      lastInteraction: s.lastSeen.substring(0, 10),
    };
    // addUserContact does an optimistic localStorage update then server sync.
    // After await, cache is fresh and emitChange("contacts") has fired.
    await addUserContact(stub);
    setUserContacts(getUserContacts());
    notifyContacts();
    handleMobileSelect(stub.id);
  }, [notifyContacts, selfEmailDomain]);

  const handleMoveDirectory = useCallback(
    async (id: string, target: ContactDirectory) => {
      // Only user-added contacts can move — seed contacts are hardcoded.
      const moved = await updateUserContact(id, { directory: target });
      if (moved) {
        setUserContacts(getUserContacts());
        setActiveDirectory(target);
        notifyContacts();
      }
    },
    [notifyContacts]
  );

  const handleDismiss = useCallback((id: string) => {
    dismissSuggestion(id);
    setDismissedIds(getDismissedSuggestionIds());
  }, []);

  const visibleSuggestions = useMemo(
    () =>
      suggestions.filter(
        (s) =>
          !dismissedIds.includes(s.id) &&
          !contacts.some(
            (c) =>
              c.id === s.id ||
              (c.email && s.email && c.email.toLowerCase() === s.email.toLowerCase())
          )
      ),
    [suggestions, dismissedIds, contacts]
  );

  // Helper to get the best lastInteraction for a contact
  function getLastInteraction(contactId: string, fallback?: string): string | undefined {
    const live = liveActivity.find((a) => a.contactId === contactId);
    return live?.lastInteraction || fallback;
  }

  function getLiveItems(contactId: string): string[] {
    return liveActivity.find((a) => a.contactId === contactId)?.recentItems || [];
  }

  function getLiveSources(contactId: string): string[] {
    return liveActivity.find((a) => a.contactId === contactId)?.sources || [];
  }

  function getZoomCadence(contactId: string): string | null {
    return liveActivity.find((a) => a.contactId === contactId)?.zoomCadence ?? null;
  }

  function getZoomMeetingCount(contactId: string): number {
    return liveActivity.find((a) => a.contactId === contactId)?.zoomMeetingCount ?? 0;
  }

  const allTags = Array.from(
    new Set(directoryContacts.flatMap((c) => c.tags))
  ).sort();

  const filtered = directoryContacts.filter((c) => {
    const matchesSearch =
      !search ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.title.toLowerCase().includes(search.toLowerCase()) ||
      c.company.toLowerCase().includes(search.toLowerCase());
    const matchesTag = tagFilter === "all" || c.tags.includes(tagFilter);
    return matchesSearch && matchesTag;
  });

  // Find selected across ALL contacts so detail survives a directory switch.
  const selectedBase = contacts.find((c) => c.id === selectedId) || null;

  // Merge any profile override on top of the base contact record. Overrides are
  // produced by "Generate profile with Basil" and held in localStorage.
  const selected = useMemo<Contact | null>(() => {
    if (!selectedBase) return null;
    const ov = overrides[selectedBase.id];
    if (!ov) return selectedBase;
    return {
      ...selectedBase,
      personality: ov.personality ?? selectedBase.personality,
      whatMakesThemTick:
        ov.whatMakesThemTick ?? selectedBase.whatMakesThemTick,
      watchOut: ov.watchOut ?? selectedBase.watchOut,
      recentActivity: ov.recentActivity ?? selectedBase.recentActivity,
      activitySource: ov.activitySource ?? selectedBase.activitySource,
    };
  }, [selectedBase, overrides]);

  const selectedOverride = selectedBase
    ? overrides[selectedBase.id]
    : undefined;

  const isSelectedUserContact = useMemo(
    () => (selected ? userContacts.some((c) => c.id === selected.id) : false),
    [selected, userContacts]
  );

  const handleSaveOverride = useCallback(
    (contactId: string, profile: ProfileOverride) => {
      // setOverride is async with optimistic local update — fire and read cache
      // synchronously; server sync runs in the background.
      void setOverride(contactId, profile);
      setOverrides(getAllOverrides());
    },
    []
  );

  const handleClearOverride = useCallback((contactId: string) => {
    void clearOverride(contactId);
    setOverrides(getAllOverrides());
  }, []);

  // On mobile, selecting a contact flips the view to the detail panel.
  function handleMobileSelect(id: string) {
    setSelectedId(id);
    setMobileView("detail");
  }

  return (
    <div className="flex h-full">
      {/* Left panel — contact list.
          Mobile: full-width list view; hidden when showing detail.
          Desktop (lg+): fixed-width sidebar, always visible. */}
      <div
        className={
          mobileView === "detail"
            ? "hidden lg:flex lg:w-80 lg:shrink-0 flex-col border-r border-border"
            : "flex w-full flex-col lg:w-80 lg:shrink-0 border-r border-border"
        }
      >
        {/* Directory switcher — keeps work contacts (Slack/Gmail signal) and
            personal contacts (WhatsApp, friends, family) in separate views. */}
        <div className="grid grid-cols-2 border-b border-border shrink-0">
          {(["work", "personal"] as const).map((dir) => {
            const active = activeDirectory === dir;
            const count = counts[dir];
            const Icon = dir === "work" ? Briefcase : Home;
            return (
              <button
                key={dir}
                type="button"
                onClick={() => setActiveDirectory(dir)}
                className={`flex items-center justify-center gap-1.5 py-2.5 text-[12px] font-semibold uppercase tracking-[0.18em] transition-colors ${
                  active
                    ? "text-[oklch(0.58_0.15_85)] border-b-2 border-[oklch(0.72_0.15_85)] bg-[oklch(0.72_0.15_85)]/[0.06]"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                aria-pressed={active}
              >
                <Icon className="h-3.5 w-3.5" />
                {dir}
                <span className="font-mono tabular-nums text-[12px] text-muted-foreground">
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="p-4 space-y-3 border-b border-border shrink-0">
          {/* Refresh row — always visible, not buried in health panel */}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              {activityFetchedAt
                ? (() => {
                    const mins = Math.floor((Date.now() - new Date(activityFetchedAt).getTime()) / 60000);
                    if (mins < 1) return "Updated just now";
                    if (mins === 1) return "Updated 1 min ago";
                    return `Updated ${mins} min ago`;
                  })()
                : "Activity not yet loaded"}
            </span>
            <button
              onClick={refreshActivity}
              disabled={activityLoading}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-[oklch(0.72_0.15_85)] transition-colors disabled:opacity-50"
              title="Refresh from Calendar, Gmail & Slack"
            >
              {activityLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Refresh
            </button>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder={`Search ${activeDirectory} contacts…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          {allTags.length > 0 && (
            <select
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
            >
              <option value="all">All tags</option>
              {allTags.map((tag) => (
                <option key={tag} value={tag}>{tag}</option>
              ))}
            </select>
          )}
          <p className="text-xs text-muted-foreground">
            {filtered.length} of {directoryContacts.length} {activeDirectory} contact
            {directoryContacts.length === 1 ? "" : "s"}
          </p>
        </div>
        {/* Scrollable area: relationship health + suggestions + contact list */}
        <div className="flex-1 overflow-y-auto min-h-0">
        {/* Relationship Heat Map */}
        <div className="px-4 py-3 border-b border-border">
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={() => {
                const next = !healthCollapsed;
                setHealthCollapsed(next);
                try { localStorage.setItem("sage-health-collapsed", String(next)); } catch { /* ignore */ }
              }}
              className="text-[12px] font-semibold tracking-widest uppercase text-muted-foreground flex items-center gap-1 hover:text-foreground transition-colors"
            >
              <Flame className="h-3 w-3" /> Relationship Health
              {isLive && !healthCollapsed && (
                <Badge className="bg-emerald-500/15 text-emerald-500 border-emerald-500/30 text-[12px] ml-1 py-0 px-1 gap-0.5">
                  <Wifi className="h-2 w-2" /> Live
                </Badge>
              )}
              {healthCollapsed
                ? <ChevronDown className="h-3 w-3 ml-1 text-muted-foreground/60" />
                : <ChevronUp className="h-3 w-3 ml-1 text-muted-foreground/60" />}
            </button>
            {!healthCollapsed && (
              <button
                onClick={refreshActivity}
                disabled={activityLoading}
                className="text-muted-foreground/50 hover:text-[oklch(0.72_0.15_85)] transition-colors"
                title="Refresh from Calendar, Gmail & Slack"
              >
                {activityLoading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
              </button>
            )}
          </div>
          {!healthCollapsed && <div className="flex flex-wrap gap-1.5">
            {[...directoryContacts]
              .sort((a, b) => {
                const ia = getLastInteraction(a.id, a.lastInteraction);
                const ib = getLastInteraction(b.id, b.lastInteraction);
                const da = ia ? new Date(ia).getTime() : 0;
                const db = ib ? new Date(ib).getTime() : 0;
                return da - db; // stale first
              })
              .map((c) => {
                const interaction = getLastInteraction(c.id, c.lastInteraction);
                const days = interaction
                  ? (() => {
                      // Count only weekdays (Mon–Fri) between lastInteraction and now
                      const start = new Date(interaction);
                      const end = new Date();
                      let weekdays = 0;
                      const cur = new Date(start);
                      cur.setHours(0, 0, 0, 0);
                      const endDay = new Date(end);
                      endDay.setHours(0, 0, 0, 0);
                      while (cur < endDay) {
                        const dow = cur.getDay();
                        if (dow !== 0 && dow !== 6) weekdays++;
                        cur.setDate(cur.getDate() + 1);
                      }
                      return weekdays;
                    })()
                  : 999;
                const ringColor = days <= 5 ? "ring-emerald-500" : days <= 10 ? "ring-amber-500" : "ring-red-500";
                const liveSources = getLiveSources(c.id);
                const liveItems = getLiveItems(c.id);
                return (
                  <Tooltip key={c.id}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setSelectedId(c.id)}
                        className={`ring-[3px] ring-offset-1 ring-offset-transparent ${ringColor} rounded-full transition-transform hover:scale-110`}
                      >
                        <ContactAvatar
                          initials={c.initials}
                          color={c.color}
                          photoUrl={photos[c.email?.toLowerCase() ?? ""]}
                          className="h-7 w-7"
                          fallbackClassName="text-[12px]"
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs max-w-52">
                      <p className="font-medium">{c.name}</p>
                      <p className="text-muted-foreground">
                        {days === 999 ? "No interaction data" : `${days}d ago`}
                        {liveSources.length > 0 ? ` (${liveSources.join(", ")})` : ""}
                      </p>
                      {getZoomCadence(c.id) && (
                        <p className="text-blue-400 mt-0.5">
                          Zoom: {getZoomCadence(c.id)} ({getZoomMeetingCount(c.id)} meetings/30d)
                        </p>
                      )}
                      {liveItems[0] && (
                        <p className="text-muted-foreground mt-0.5 truncate">{liveItems[0]}</p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
          </div>}
        </div>
        {/* Suggested contacts — people with real email/Slack signal not yet
            tracked. Only shown in the Work directory because the signal sources
            are Gmail + Slack. */}
        {activeDirectory === "work" && (
        <div className="px-4 py-3 border-b border-border">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[12px] font-semibold tracking-widest uppercase text-muted-foreground flex items-center gap-1">
              <Sparkles className="h-3 w-3" /> Suggested
              {visibleSuggestions.length > 0 && (
                <span className="text-[12px] font-mono text-muted-foreground ml-1 tabular-nums">
                  {visibleSuggestions.length}
                </span>
              )}
            </p>
            <button
              onClick={refreshSuggestions}
              disabled={suggestLoading}
              className="text-muted-foreground/50 hover:text-[oklch(0.72_0.15_85)] transition-colors"
              title="Scan recent email & Slack for people not yet in contacts"
            >
              {suggestLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
            </button>
          </div>
          {visibleSuggestions.length === 0 ? (
            <p className="text-[12px] text-muted-foreground leading-relaxed">
              {suggestions.length === 0
                ? "Click refresh to scan recent signal for new people."
                : "All caught up — no new people to suggest."}
            </p>
          ) : (
            <div className="space-y-1.5">
              {visibleSuggestions.slice(0, 5).map((s) => (
                <div
                  key={s.id}
                  className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/50"
                >
                  <Avatar className="h-6 w-6 shrink-0">
                    <AvatarFallback
                      className={`text-[12px] text-white font-medium ${pickAvatarColor(s.displayName)}`}
                    >
                      {initialsFor(s.displayName)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate leading-tight">
                      {s.displayName}
                    </p>
                    <p className="text-[12px] text-muted-foreground truncate leading-tight">
                      {s.emailCount > 0 && `${s.emailCount} email${s.emailCount === 1 ? "" : "s"}`}
                      {s.emailCount > 0 && s.slackCount > 0 && " · "}
                      {s.slackCount > 0 && `${s.slackCount} slack`}
                    </p>
                  </div>
                  <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
                    <button
                      onClick={() => handleAddSuggestion(s)}
                      className="rounded p-1 hover:bg-emerald-500/20 hover:text-emerald-600 transition-colors"
                      title={`Add ${s.displayName} as a contact`}
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => handleDismiss(s.id)}
                      className="rounded p-1 hover:bg-rose-500/20 hover:text-rose-600 transition-colors"
                      title="Dismiss"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        )}

        {/* Personal directory empty-state — surfaces the WhatsApp path. */}
        {activeDirectory === "personal" && directoryContacts.length === 0 && (
          <div className="px-4 py-6 border-b border-border space-y-3 text-center">
            <Home className="h-8 w-8 text-muted-foreground/30 mx-auto" />
            <div>
              <p className="text-sm font-medium">No personal contacts yet</p>
              <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
                Connect WhatsApp to pull in your personal threads, or move any existing contact into this directory from their profile.
              </p>
            </div>
            <Link href="/dashboard/whatsapp">
              <Button size="sm" variant="outline" className="gap-1.5">
                <MessageCircle className="h-3.5 w-3.5" />
                Import from WhatsApp
              </Button>
            </Link>
          </div>
        )}

        <div className="p-2">
          <ContactList contacts={filtered} selected={selectedId} onSelect={handleMobileSelect} photos={photos} />
        </div>
        </div>{/* end scrollable area */}
      </div>

      {/* Right panel — contact detail.
          Mobile: shown only when a contact is selected (detail view).
          Desktop (lg+): always visible, flex-1. */}
      <div
        className={
          mobileView === "detail"
            ? "flex flex-1 flex-col overflow-y-auto p-4 lg:p-8"
            : "hidden lg:flex lg:flex-1 lg:overflow-y-auto lg:p-8 flex-col"
        }
      >
        {/* Back button — mobile only */}
        {mobileView === "detail" && (
          <button
            onClick={() => setMobileView("list")}
            className="lg:hidden flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 -ml-1"
          >
            <ChevronLeft className="h-4 w-4" />
            All contacts
          </button>
        )}
        {selected ? (
          <ContactDetail
            contact={selected}
            photoUrl={photos[selected.email?.toLowerCase() ?? ""]}
            liveItems={getLiveItems(selected.id)}
            liveSources={getLiveSources(selected.id)}
            lastInteraction={getLastInteraction(selected.id, selected.lastInteraction)}
            zoomCadence={getZoomCadence(selected.id)}
            zoomMeetingCount={getZoomMeetingCount(selected.id)}
            canMove={isSelectedUserContact}
            isUserContact={isSelectedUserContact}
            onMove={(target) => handleMoveDirectory(selected.id, target)}
            onRename={(_newName) => {
              setUserContacts(getUserContacts());
              notifyContacts();
            }}
            override={selectedOverride}
            onSaveOverride={(patch) => handleSaveOverride(selected.id, patch)}
            onClearOverride={() => handleClearOverride(selected.id)}
            onContactUpdated={() => {
              // Refresh the contacts list after canonical field updates (e.g. title,
              // company, location extracted from context notes on profile save).
              setUserContacts(getUserContacts());
              notifyContacts();
            }}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Users className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <h2 className="text-lg font-medium">Select a contact</h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              Click anyone on the left to see their profile, personality insights, and activity history.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
