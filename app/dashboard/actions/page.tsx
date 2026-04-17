"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ListChecks, Plus, Trash2, Check, Search } from "lucide-react";
import { findContactByName } from "@/lib/contacts-lookup";
import type { ActionItem } from "@/lib/types/action";

const LEGACY_STORAGE_KEY = "sage-actions";

export default function ActionsPage() {
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [newText, setNewText] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newDue, setNewDue] = useState("");
  const [newSource, setNewSource] = useState<ActionItem["source"]>("manual");
  const migratedRef = useRef(false);

  async function refresh() {
    const res = await fetch("/api/actions", { cache: "no-store" });
    const data = await res.json();
    setActions(data.actions || []);
  }

  useEffect(() => {
    (async () => {
      // One-time migration: lift any legacy localStorage items into the server
      // store, then clear so the UI is single-sourced from the API.
      if (!migratedRef.current && typeof window !== "undefined") {
        migratedRef.current = true;
        try {
          const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as ActionItem[];
            if (Array.isArray(parsed) && parsed.length > 0) {
              await fetch("/api/actions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ import: parsed }),
              });
            }
            window.localStorage.removeItem(LEGACY_STORAGE_KEY);
          }
        } catch {
          /* ignore — API is authoritative */
        }
      }
      await refresh();
    })();
  }, []);

  async function handleAdd() {
    if (!newText.trim()) return;
    await fetch("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: newText,
        owner: newOwner || "Michael Cook",
        ownerId: findContactByName(newOwner)?.id,
        dueDate: newDue || undefined,
        source: newSource,
      }),
    });
    setNewText("");
    setNewOwner("");
    setNewDue("");
    setShowForm(false);
    await refresh();
  }

  async function toggleDone(id: string) {
    const current = actions.find((a) => a.id === id);
    if (!current) return;
    const next = current.status === "done" ? "open" : "done";
    await fetch(`/api/actions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    await refresh();
  }

  async function handleDelete(id: string) {
    await fetch(`/api/actions/${id}`, { method: "DELETE" });
    await refresh();
  }

  const filtered = actions.filter((a) => {
    const matchesSearch =
      !search ||
      a.text.toLowerCase().includes(search.toLowerCase()) ||
      a.owner.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || a.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const today = new Date().toISOString().split("T")[0];

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-4xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <ListChecks className="h-6 w-6 text-[oklch(0.72_0.15_85)]" />
            Action Tracker
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Commitments from meetings, Slack, and conversations. Basil can read and add to this list.
          </p>
        </div>
        <Button
          size="sm"
          className="bg-[oklch(0.22_0.05_250)] hover:bg-[oklch(0.28_0.06_250)] text-white gap-1.5"
          onClick={() => setShowForm(!showForm)}
        >
          <Plus className="h-3.5 w-3.5" />
          Add Action
        </Button>
      </header>

      {showForm && (
        <Card className="border-[oklch(0.72_0.15_85)]/30">
          <CardContent className="p-4 space-y-3">
            <Textarea
              placeholder="What needs to be done?"
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              rows={2}
            />
            <div className="flex gap-3">
              <Input
                placeholder="Owner"
                value={newOwner}
                onChange={(e) => setNewOwner(e.target.value)}
                className="flex-1"
              />
              <Input
                type="date"
                value={newDue}
                onChange={(e) => setNewDue(e.target.value)}
                className="w-40"
              />
              <select
                value={newSource}
                onChange={(e) => setNewSource(e.target.value as ActionItem["source"])}
                className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
              >
                <option value="manual">Manual</option>
                <option value="meeting">Meeting</option>
                <option value="slack">Slack</option>
                <option value="email">Email</option>
                <option value="chat">Chat</option>
              </select>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleAdd} className="bg-[oklch(0.72_0.15_85)] text-[oklch(0.18_0.04_250)] hover:bg-[oklch(0.78_0.12_85)]">
                Save
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="Search actions..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
        >
          <option value="all">All status</option>
          <option value="open">Open</option>
          <option value="done">Done</option>
          <option value="overdue">Overdue</option>
        </select>
      </div>

      <div className="space-y-2">
        {filtered.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground">No actions found.</CardContent></Card>
        ) : (
          filtered.map((action) => {
            const contact = findContactByName(action.owner);
            const isOverdue = action.status === "overdue" || (action.status === "open" && action.dueDate && action.dueDate < today);
            const isDueToday = action.dueDate === today;
            return (
              <Card key={action.id} className={action.status === "done" ? "opacity-60" : ""}>
                <CardContent className="p-4 flex items-start gap-3">
                  <button
                    onClick={() => toggleDone(action.id)}
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                      action.status === "done"
                        ? "bg-emerald-500 border-emerald-500 text-white"
                        : "border-border hover:border-[oklch(0.72_0.15_85)]"
                    }`}
                  >
                    {action.status === "done" && <Check className="h-3 w-3" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm ${action.status === "done" ? "line-through text-muted-foreground" : ""}`}>
                      {action.text}
                    </p>
                    <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                      <div className="flex items-center gap-1.5">
                        {contact && (
                          <Avatar className="h-4 w-4">
                            <AvatarFallback className={`text-[12px] text-white ${contact.color}`}>
                              {contact.initials}
                            </AvatarFallback>
                          </Avatar>
                        )}
                        <span className="text-xs text-muted-foreground">{action.owner}</span>
                      </div>
                      {action.dueDate && (
                        <span className={`text-xs ${isOverdue ? "text-red-500 font-medium" : isDueToday ? "text-amber-500 font-medium" : "text-muted-foreground"}`}>
                          Due {action.dueDate}
                        </span>
                      )}
                      <Badge variant="outline" className="text-[12px]">{action.source}</Badge>
                    </div>
                  </div>
                  <button onClick={() => handleDelete(action.id)} className="text-muted-foreground/50 hover:text-destructive transition-colors">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
