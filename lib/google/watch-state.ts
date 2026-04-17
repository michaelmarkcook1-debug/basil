import { promises as fs } from "node:fs";
import path from "node:path";

// Persists the Gmail historyId and Calendar syncToken across restarts so
// webhook deliveries can be diffed against the last-seen state. Also stores
// watch-channel metadata (expiry) so the renewal cron knows when to re-subscribe.

const DATA_DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "google-watch.json");

export interface GmailWatchState {
  historyId?: string;
  expiration?: number; // ms epoch
}

export interface CalendarWatchState {
  channelId?: string;
  resourceId?: string;
  syncToken?: string;
  expiration?: number; // ms epoch
}

export interface WatchState {
  gmail?: GmailWatchState;
  calendar?: CalendarWatchState;
}

async function read(): Promise<WatchState> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as WatchState;
  } catch {
    return {};
  }
}

async function write(state: WatchState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(state, null, 2), "utf8");
}

export async function getWatchState(): Promise<WatchState> {
  return read();
}

export async function updateGmail(patch: Partial<GmailWatchState>): Promise<void> {
  const s = await read();
  s.gmail = { ...s.gmail, ...patch };
  await write(s);
}

export async function updateCalendar(patch: Partial<CalendarWatchState>): Promise<void> {
  const s = await read();
  s.calendar = { ...s.calendar, ...patch };
  await write(s);
}
