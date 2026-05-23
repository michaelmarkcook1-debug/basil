"use client";

export function OfflineReload() {
  return (
    <button
      onClick={() => window.location.reload()}
      className="mt-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
    >
      Try again
    </button>
  );
}
