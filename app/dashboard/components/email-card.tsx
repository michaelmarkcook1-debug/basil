"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Mail, Unplug, Search, ChevronLeft } from "lucide-react";
import { relativeTime } from "@/lib/utils";
import Link from "next/link";

interface Email {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
}

interface EmailResponse {
  connected: boolean;
  emails: Email[];
  message: string;
}

export function EmailCard() {
  const [data, setData] = useState<EmailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [emailBody, setEmailBody] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);

  useEffect(() => {
    fetch("/api/email")
      .then((res) => res.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch((e: unknown) => {
        console.error("[basil-fetch] network_error", { route: "/api/email", component: "EmailCard", error: e instanceof Error ? e.message : String(e) });
        setData({ connected: false, emails: [], message: "Failed to load" });
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!selectedEmail) {
      setEmailBody(null);
      return;
    }

    let cancelled = false;
    setBodyLoading(true);
    setEmailBody(null);

    fetch(`/api/email/${selectedEmail.id}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch");
        return res.json();
      })
      .then((d) => {
        if (!cancelled) {
          setEmailBody(d.body ?? selectedEmail.snippet);
          setBodyLoading(false);
        }
      })
      .catch((e: unknown) => {
        console.error("[basil-fetch] network_error", { route: `/api/email/${selectedEmail.id}`, component: "EmailCard", error: e instanceof Error ? e.message : String(e) });
        if (!cancelled) {
          setEmailBody(selectedEmail.snippet);
          setBodyLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [selectedEmail]);

  const unreadCount = data?.emails?.filter((e) => e.unread).length ?? 0;

  return (
    <Card className="border-[oklch(0.72_0.15_85)]/30 flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">
          <Mail className="mr-2 inline h-4 w-4 text-[oklch(0.72_0.15_85)]" />
          {selectedEmail ? "Email" : "Recent Emails"}
        </CardTitle>
        <div className="flex items-center gap-2">
          {data?.connected && unreadCount > 0 && !selectedEmail && (
            <Badge variant="secondary" className="text-xs">
              {unreadCount} unread
            </Badge>
          )}
          {/* Search link → opens Basil chat with email search context */}
          {!selectedEmail && (
            <Link
              href="/dashboard/chat?q=search+emails"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Search className="h-3 w-3" />
            </Link>
          )}
          {selectedEmail && (
            <button
              onClick={() => setSelectedEmail(null)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="h-3 w-3" /> Back
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-1 min-h-0">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))}
          </div>
        ) : !data?.connected ? (
          <div className="flex flex-col items-center py-6 text-center">
            <Unplug className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">{data?.message}</p>
            <Link href="/dashboard/settings" className="text-xs text-[oklch(0.72_0.15_85)] hover:underline mt-2">
              Connect Gmail
            </Link>
          </div>
        ) : selectedEmail ? (
          /* Expanded email view */
          <div className="space-y-3">
            <div>
              <p className="text-sm font-semibold">{selectedEmail.from}</p>
              <p className="text-sm font-medium">{selectedEmail.subject}</p>
              <p className="text-xs text-muted-foreground">{relativeTime(selectedEmail.date)}</p>
            </div>
            <Separator />
            {bodyLoading ? (
              <div className="space-y-2 py-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
                <Skeleton className="h-3 w-3/5" />
              </div>
            ) : (
              <ScrollArea className="max-h-[260px]">
                <p className="text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap">
                  {emailBody ?? selectedEmail.snippet}
                </p>
              </ScrollArea>
            )}
            <div className="flex gap-2 pt-2">
              <Link
                href={`/dashboard/chat?q=reply+to+email+from+${encodeURIComponent(selectedEmail.from)}+about+${encodeURIComponent(selectedEmail.subject)}`}
                className="text-xs text-[oklch(0.72_0.15_85)] hover:underline font-medium"
              >
                Draft reply with Basil
              </Link>
            </div>
          </div>
        ) : data.emails.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-sm text-muted-foreground">No recent emails. Inbox zero!</p>
          </div>
        ) : (
          /* Scrollable email list */
          <ScrollArea className="h-[320px] -mx-2">
            <div className="space-y-1 px-2">
              {data.emails.map((email) => (
                <button
                  key={email.id}
                  onClick={() => setSelectedEmail(email)}
                  className="w-full text-left rounded-md p-2 transition-colors hover:bg-accent/50"
                >
                  <div className="flex items-center justify-between">
                    <p className={`text-sm truncate ${email.unread ? "font-semibold" : "font-medium"}`}>
                      {email.from}
                    </p>
                    <span className="text-xs text-muted-foreground shrink-0 ml-2">
                      {relativeTime(email.date)}
                    </span>
                  </div>
                  <p className={`text-sm truncate ${email.unread ? "text-foreground" : "text-muted-foreground"}`}>
                    {email.subject}
                  </p>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {email.snippet}
                  </p>
                </button>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
