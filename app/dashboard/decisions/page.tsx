"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Scale, Plus, Search, Archive } from "lucide-react";
import { findContactByName } from "@/lib/contacts-lookup";
import type { Decision } from "@/lib/types/decision";

const LEGACY_STORAGE_KEY = "sage-decisions";

export default function DecisionsPage() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [newText, setNewText] = useState("");
  const [newBy, setNewBy] = useState("");
  const [newDate, setNewDate] = useState(new Date().toISOString().split("T")[0]);
  const [newContext, setNewContext] = useState("");
  const migratedRef = useRef(false);

  async function refresh() {
    const res = await fetch("/api/decisions", { cache: "no-store" });
    const data = await res.json();
    setDecisions(data.decisions || []);
  }

  useEffect(() => {
    (async () => {
      if (!migratedRef.current && typeof window !== "undefined") {
        migratedRef.current = true;
        try {
          const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as Decision[];
            if (Array.isArray(parsed) && parsed.length > 0) {
              await fetch("/api/decisions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ import: parsed }),
              });
            }
            window.localStorage.removeItem(LEGACY_STORAGE_KEY);
          }
        } catch {
          /* ignore */
        }
      }
      await refresh();
    })();
  }, []);

  async function handleAdd() {
    if (!newText.trim()) return;
    await fetch("/api/decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: newText,
        decidedBy: newBy || "Unknown",
        decidedById: findContactByName(newBy)?.id,
        date: newDate,
        context: newContext,
      }),
    });
    setNewText("");
    setNewBy("");
    setNewContext("");
    setShowForm(false);
    await refresh();
  }

  async function toggleSuperseded(id: string) {
    const current = decisions.find((d) => d.id === id);
    if (!current) return;
    const next = current.status === "active" ? "superseded" : "active";
    await fetch(`/api/decisions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    await refresh();
  }

  const filtered = decisions.filter(
    (d) =>
      !search ||
      d.text.toLowerCase().includes(search.toLowerCase()) ||
      d.decidedBy.toLowerCase().includes(search.toLowerCase()) ||
      d.context.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-4xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Scale className="h-6 w-6 text-[oklch(0.72_0.15_85)]" />
            Decision Log
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Major decisions tracked across meetings, Slack, and email. Basil can read and log to this list.
          </p>
        </div>
        <Button
          size="sm"
          className="bg-[oklch(0.22_0.05_250)] hover:bg-[oklch(0.28_0.06_250)] text-white gap-1.5"
          onClick={() => setShowForm(!showForm)}
        >
          <Plus className="h-3.5 w-3.5" />
          Log Decision
        </Button>
      </header>

      {showForm && (
        <Card className="border-[oklch(0.72_0.15_85)]/30">
          <CardContent className="p-4 space-y-3">
            <Textarea placeholder="What was decided?" value={newText} onChange={(e) => setNewText(e.target.value)} rows={2} />
            <div className="flex gap-3">
              <Input placeholder="Decided by" value={newBy} onChange={(e) => setNewBy(e.target.value)} className="flex-1" />
              <Input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className="w-40" />
            </div>
            <Input placeholder="Context / source (e.g., 'Slack #ap-launch')" value={newContext} onChange={(e) => setNewContext(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleAdd} className="bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)]">
                Save
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input placeholder="Search decisions..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
      </div>

      <div className="space-y-3">
        {filtered.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground">No decisions logged yet.</CardContent></Card>
        ) : (
          filtered.map((d) => {
            const contact = findContactByName(d.decidedBy);
            return (
              <Card key={d.id} className={d.status === "superseded" ? "opacity-50" : ""}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <p className={`text-sm font-medium ${d.status === "superseded" ? "line-through" : ""}`}>
                        {d.text}
                      </p>
                      <div className="flex items-center gap-3 mt-2 flex-wrap">
                        <div className="flex items-center gap-1.5">
                          {contact && (
                            <Avatar className="h-4 w-4">
                              <AvatarFallback className={`text-[12px] text-white ${contact.color}`}>
                                {contact.initials}
                              </AvatarFallback>
                            </Avatar>
                          )}
                          <span className="text-xs text-muted-foreground">{d.decidedBy}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">{d.date}</span>
                        <Badge
                          variant="outline"
                          className={d.status === "active" ? "border-emerald-400 text-emerald-600 text-[12px]" : "text-[12px]"}
                        >
                          {d.status}
                        </Badge>
                      </div>
                      {d.context && (
                        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{d.context}</p>
                      )}
                    </div>
                    <button
                      onClick={() => toggleSuperseded(d.id)}
                      className="text-muted-foreground/50 hover:text-foreground transition-colors"
                      title={d.status === "active" ? "Mark superseded" : "Reactivate"}
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
