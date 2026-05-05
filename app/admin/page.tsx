"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Shield, Users, LogOut, Trash2, Ban, CheckCircle, RefreshCw, ArrowLeft, Clock, Mail, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

interface AdminUser {
  id: string;
  name: string;
  surname: string;
  username: string;
  email: string;
  country: string;
  createdAt: string;
  lastLoginAt?: string;
  onboardingCompleted?: boolean;
  disabled?: boolean;
  sessionVersion?: number;
}

type ConfirmAction =
  | { type: "revoke"; user: AdminUser }
  | { type: "disable"; user: AdminUser }
  | { type: "enable"; user: AdminUser }
  | { type: "delete"; user: AdminUser }
  | null;

function formatDate(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function formatDatetime(iso?: string) {
  if (!iso) return "Never";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function AdminPage() {
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<ConfirmAction>(null);
  const [acting, setActing] = useState<string | null>(null); // user id being acted on

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/users");
      const data = await r.json();
      setUsers(data.users ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function doAction(userId: string, action: "revoke" | "disable" | "enable" | "delete") {
    setActing(userId);
    setConfirm(null);
    try {
      const method = action === "delete" ? "DELETE" : "PATCH";
      const body = action !== "delete" ? JSON.stringify({ action }) : undefined;
      await fetch(`/api/admin/users/${userId}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body,
      });
      await load();
    } finally {
      setActing(null);
    }
  }

  const totalUsers = users.length;
  const activeUsers = users.filter((u) => !u.disabled).length;
  const disabledUsers = users.filter((u) => u.disabled).length;

  return (
    <div className="min-h-screen basil-surface">
      <div className="max-w-4xl mx-auto px-4 py-8 sm:px-6">

        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/dashboard")}
            className="gap-1.5 text-muted-foreground -ml-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Dashboard
          </Button>
        </div>

        <div className="flex items-start justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Shield className="h-5 w-5 text-[oklch(0.72_0.15_85)]" />
              <h1 className="basil-display text-2xl sm:text-3xl">Admin Panel</h1>
            </div>
            <p className="text-sm text-muted-foreground">Manage users, sessions, and account access.</p>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5 shrink-0">
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          {[
            { label: "Total users", value: totalUsers, icon: Users },
            { label: "Active", value: activeUsers, icon: CheckCircle, color: "text-green-600" },
            { label: "Disabled", value: disabledUsers, icon: Ban, color: "text-destructive" },
          ].map(({ label, value, icon: Icon, color }) => (
            <Card key={label} className="shadow-sm">
              <CardContent className="p-4 flex items-center gap-3">
                <Icon className={cn("h-5 w-5 shrink-0 text-muted-foreground", color)} />
                <div>
                  <p className="text-xl font-semibold leading-none">{value}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Users list */}
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              Registered Users
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="h-5 w-5 rounded-full border-2 border-[oklch(0.72_0.15_85)] border-t-transparent animate-spin" />
              </div>
            ) : users.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-12">No users found.</p>
            ) : (
              <ul className="divide-y divide-border">
                {users.map((user, i) => (
                  <li key={user.id} className={cn("px-4 py-4 sm:px-6", user.disabled && "opacity-60")}>
                    <div className="flex items-start justify-between gap-4">
                      {/* Identity */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">{user.name} {user.surname}</span>
                          <span className="text-xs text-muted-foreground font-mono">@{user.username}</span>
                          {i === 0 && user.id === "env-admin" ? (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">env-admin</Badge>
                          ) : null}
                          {user.disabled && (
                            <Badge variant="destructive" className="text-[10px] px-1.5 py-0">disabled</Badge>
                          )}
                          {!user.onboardingCompleted && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">onboarding</Badge>
                          )}
                        </div>

                        <div className="flex items-center gap-3 mt-1.5 flex-wrap text-xs text-muted-foreground">
                          {user.email && (
                            <span className="flex items-center gap-1 truncate">
                              <Mail className="h-3 w-3 shrink-0" />
                              {user.email}
                            </span>
                          )}
                          {user.country && (
                            <span className="flex items-center gap-1">
                              <Globe className="h-3 w-3 shrink-0" />
                              {user.country}
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3 shrink-0" />
                            Joined {formatDate(user.createdAt)}
                          </span>
                          <span className="flex items-center gap-1">
                            Last login: {formatDatetime(user.lastLoginAt)}
                          </span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1.5 shrink-0">
                        {acting === user.id ? (
                          <div className="h-4 w-4 rounded-full border-2 border-[oklch(0.72_0.15_85)] border-t-transparent animate-spin" />
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Revoke all sessions (force logout)"
                              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                              onClick={() => setConfirm({ type: "revoke", user })}
                              disabled={user.id === "env-admin" && user.disabled === undefined}
                            >
                              <LogOut className="h-3.5 w-3.5" />
                            </Button>

                            {user.disabled ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Enable account"
                                className="h-8 w-8 p-0 text-green-600 hover:text-green-700"
                                onClick={() => setConfirm({ type: "enable", user })}
                              >
                                <CheckCircle className="h-3.5 w-3.5" />
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Disable account"
                                className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                                onClick={() => setConfirm({ type: "disable", user })}
                                disabled={user.id === "env-admin"}
                              >
                                <Ban className="h-3.5 w-3.5" />
                              </Button>
                            )}

                            <Button
                              variant="ghost"
                              size="sm"
                              title="Delete user"
                              className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                              onClick={() => setConfirm({ type: "delete", user })}
                              disabled={user.id === "env-admin"}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                    {i < users.length - 1 ? null : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground text-center mt-6">
          Only <strong>@{process.env.NEXT_PUBLIC_ADMIN_USERNAME ?? "admin"}</strong> can access this panel. {/* ci-ok: display-only label, not an auth check */}
        </p>
      </div>

      {/* Confirm dialog */}
      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.type === "revoke" && "Revoke all sessions?"}
              {confirm?.type === "disable" && "Disable this account?"}
              {confirm?.type === "enable" && "Re-enable this account?"}
              {confirm?.type === "delete" && "Delete this user?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.type === "revoke" && (
                <>Logs <strong>@{confirm.user.username}</strong> out of all active sessions immediately. They can log in again with their password.</>
              )}
              {confirm?.type === "disable" && (
                <>Suspends <strong>@{confirm.user.username}</strong> and revokes all sessions. They will not be able to log in until re-enabled.</>
              )}
              {confirm?.type === "enable" && (
                <>Re-enables <strong>@{confirm.user.username}</strong>. They will be able to log in again.</>
              )}
              {confirm?.type === "delete" && (
                <>Permanently deletes <strong>@{confirm.user.username}</strong> and all their data. This cannot be undone.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirm && doAction(confirm.user.id, confirm.type)}
              className={cn(
                confirm?.type === "delete" || confirm?.type === "disable"
                  ? "bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                  : ""
              )}
            >
              {confirm?.type === "revoke" && "Revoke sessions"}
              {confirm?.type === "disable" && "Disable account"}
              {confirm?.type === "enable" && "Re-enable"}
              {confirm?.type === "delete" && "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
