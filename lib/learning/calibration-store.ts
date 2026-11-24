/**
 * lib/learning/calibration-store.ts — the per-source review bar
 * (lib/learning/calibration.ts) for the materializers, from the learning log.
 * Cached per user for 10 minutes; any failure gives the default bar.
 */
import "server-only";
import { getLearning } from "@/lib/learning/store";
import { calibrate, DEFAULT_AUTO, type SourceCalibration, type SourceType } from "@/lib/learning/calibration";

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; cal: Record<SourceType, SourceCalibration> }>();

export async function sourceCalibration(username: string): Promise<Record<SourceType, SourceCalibration> | null> {
  const hit = cache.get(username);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.cal;
  try {
    const cal = calibrate((await getLearning(username)).events);
    cache.set(username, { at: Date.now(), cal });
    return cal;
  } catch (e) {
    console.warn("[learning/calibration] unavailable, using the default review bar:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Confidence at which an action from this source is created without review. Never throws. */
export async function actionAutoBar(username: string, source: SourceType): Promise<number> {
  return (await sourceCalibration(username))?.[source]?.autoBar ?? DEFAULT_AUTO;
}
