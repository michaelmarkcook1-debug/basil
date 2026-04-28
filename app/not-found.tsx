import Link from "next/link";
import { Search } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[oklch(0.18_0.05_250)] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="flex justify-center">
          <div className="p-4 rounded-full bg-white/5 border border-white/10">
            <Search className="w-10 h-10 text-white/40" />
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-white/30 text-sm font-mono tracking-widest uppercase">
            404
          </p>
          <h1
            className="text-2xl font-semibold text-white"
            style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}
          >
            Page not found
          </h1>
          <p className="text-white/50 text-sm">
            This page doesn&apos;t exist or has been moved.
          </p>
        </div>

        <Link
          href="/dashboard"
          className="inline-block px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
