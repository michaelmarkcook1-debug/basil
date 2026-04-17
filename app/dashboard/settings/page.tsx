"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Settings, CheckCircle, Circle, Calendar, Mail, FileText, Hash, Bot } from "lucide-react";

interface GoogleStatus { calendar: boolean; gmail: boolean; drive: boolean; any: boolean }

export default function SettingsPage() {
  const [google, setGoogle] = useState<GoogleStatus>({ calendar: false, gmail: false, drive: false, any: false });
  const [slackConnected, setSlackConnected] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // Check per-scope Google status (Calendar/Gmail/Drive can be granted
    // independently) and Slack connection.
    Promise.all([
      fetch("/api/google/status").then((r) => r.json()),
      fetch("/api/slack").then((r) => r.json()),
    ]).then(([g, slack]) => {
      setGoogle(g);
      setSlackConnected(slack.connected);
      setChecking(false);
    }).catch(() => setChecking(false));
  }, []);

  const googleConnected = google.any;

  const integrations = [
    {
      name: "Google Calendar",
      icon: Calendar,
      connected: google.calendar,
      description: "View and manage calendar events",
      color: "text-[oklch(0.72_0.15_85)]",
      google: true,
    },
    {
      name: "Gmail",
      icon: Mail,
      connected: google.gmail,
      description: "Read and draft emails",
      color: "text-pink-500",
      google: true,
    },
    {
      name: "Google Drive",
      icon: FileText,
      connected: google.drive,
      description: "Search and read documents",
      color: "text-amber-500",
      google: true,
    },
    {
      name: "Slack",
      icon: Hash,
      connected: slackConnected,
      description: "Read and send Slack messages",
      color: "text-emerald-500",
      google: false,
    },
    {
      name: "AI Assistant (Claude)",
      icon: Bot,
      connected: true, // If the page loads, the API key is set
      description: "AI chat powered by Anthropic Claude",
      color: "text-violet-500",
      google: false,
    },
  ];

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-2xl pb-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Settings className="h-6 w-6 text-[oklch(0.72_0.15_85)]" />
          Settings
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage integrations and preferences.
        </p>
      </header>

      {!googleConnected && !checking && (
        <Card className="border-[oklch(0.72_0.15_85)]/30 bg-[oklch(0.72_0.15_85)]/5">
          <CardContent className="py-6 text-center space-y-3">
            <p className="font-medium">Connect Google to unlock Calendar, Gmail, and Drive</p>
            <p className="text-sm text-muted-foreground">
              One-time authorization. Basil will be able to read your calendar, emails, and documents.
            </p>
            <Button
              className="bg-[oklch(0.22_0.05_250)] hover:bg-[oklch(0.28_0.06_250)] text-white"
              onClick={() => { window.location.href = "/api/auth/google"; }}
            >
              Connect Google Account
            </Button>
          </CardContent>
        </Card>
      )}

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Integrations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {integrations.map((integration, i) => (
            <div key={integration.name}>
              <div className="flex items-center gap-3">
                <integration.icon className={`h-5 w-5 ${integration.color}`} />
                <div className="flex-1">
                  <p className="text-sm font-medium">{integration.name}</p>
                  <p className="text-sm text-muted-foreground">{integration.description}</p>
                </div>
                {checking ? (
                  <Badge variant="secondary" className="text-xs">Checking...</Badge>
                ) : integration.connected ? (
                  <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 gap-1">
                    <CheckCircle className="h-3 w-3" /> Connected
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1 text-muted-foreground">
                    <Circle className="h-3 w-3" /> Not connected
                  </Badge>
                )}
              </div>
              {i < integrations.length - 1 && <Separator className="mt-4" />}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Name</span>
            <span className="font-medium">Michael Cook</span>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Timezone</span>
            <span className="font-medium">Europe/London</span>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Work hours</span>
            <span className="font-medium">12:00 - 20:00 UK</span>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Video calls</span>
            <span className="font-medium">Zoom only</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
