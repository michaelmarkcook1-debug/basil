"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      // Hard redirect so the browser sends the new cookie on the next request
      window.location.href = "/dashboard";
    } else {
      setError("Wrong password");
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center p-4 bg-[oklch(0.22_0.05_250)]">
      <Card className="w-full max-w-sm shadow-2xl shadow-black/20 border-[oklch(0.72_0.15_85)]/30">
        <CardHeader className="text-center space-y-2 pb-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/basil-logo.svg" alt="Basil" className="mx-auto h-12 w-12 rounded-xl shadow-lg" />
          <h1 className="text-2xl font-semibold text-[oklch(0.22_0.05_250)]">
            Basil
          </h1>
          <p className="text-sm text-muted-foreground">
            Your executive assistant
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                autoFocus
              />
            </div>
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
            <Button
              type="submit"
              className="w-full bg-[oklch(0.22_0.05_250)] hover:bg-[oklch(0.28_0.06_250)] text-white shadow-md"
              disabled={loading}
            >
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
