import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function getGreeting(): string {
  const hour = new Date().toLocaleString("en-GB", {
    timeZone: "Europe/London",
    hour: "numeric",
    hour12: false,
  });
  const h = parseInt(hour);
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export function formatTime(date: Date | string): string {
  return new Date(date).toLocaleTimeString("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatTimeRange(start: Date | string, end: Date | string): string {
  return `${formatTime(start)} - ${formatTime(end)}`;
}

export function relativeTime(date: Date | string): string {
  const now = new Date();
  const then = new Date(date);
  const diff = now.getTime() - then.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
