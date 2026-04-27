"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch("/api/admin/users")
      .then((r) => {
        if (r.status === 403) router.replace("/dashboard");
        else setChecking(false);
      })
      .catch(() => router.replace("/dashboard"));
  }, [router]);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-5 w-5 rounded-full border-2 border-[oklch(0.72_0.15_85)] border-t-transparent animate-spin" />
      </div>
    );
  }

  return <>{children}</>;
}
