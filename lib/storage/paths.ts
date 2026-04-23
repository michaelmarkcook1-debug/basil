/**
 * On Vercel, process.cwd() (/var/task) is read-only.
 * Use /tmp/basil-data instead — it's writable and persists within
 * the same Fluid Compute instance. Data is also serialised into the
 * BASIL_DATA env var so it survives cold starts.
 */
import path from "node:path";

export const DATA_DIR = process.env.VERCEL
  ? "/tmp/basil-data"
  : path.join(process.cwd(), ".data");
