"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Paperclip,
  Folder,
  X,
  FileText,
  FileImage,
  FileQuestion,
  FileSpreadsheet,
  FileType,
  Presentation,
  Link as LinkIcon,
  Plus,
  UploadCloud,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Allow the non-standard `webkitdirectory` attribute on <input>. Supported by
// Chromium and Safari; React's built-in types don't know about it.
declare module "react" {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string;
  }
}

// Mirror of lib/ai/extra-context.ts — kept in sync; both are trivial.
const TEXT_EXTS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "html",
  "htm",
  "log",
  "rtf",
]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const WORD_EXTS = new Set(["docx", "doc", "odt"]);
const SHEET_EXTS = new Set(["xlsx", "xls", "xlsm", "ods", "csv", "tsv"]);
const PPT_EXTS = new Set(["pptx", "ppt", "odp"]);

function ext(name: string) {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

type FileKind = "text" | "image" | "pdf" | "word" | "sheet" | "ppt" | "other";

function kind(file: File): FileKind {
  const e = ext(file.name);
  if (WORD_EXTS.has(e)) return "word";
  if (PPT_EXTS.has(e)) return "ppt";
  if (SHEET_EXTS.has(e) && !TEXT_EXTS.has(e)) return "sheet";
  if (TEXT_EXTS.has(e) || file.type.startsWith("text/")) return "text";
  if (IMAGE_EXTS.has(e) || file.type.startsWith("image/")) return "image";
  if (e === "pdf" || file.type === "application/pdf") return "pdf";
  return "other";
}

function iconFor(k: FileKind) {
  switch (k) {
    case "image":
      return FileImage;
    case "word":
      return FileType;
    case "sheet":
      return FileSpreadsheet;
    case "ppt":
      return Presentation;
    case "text":
    case "pdf":
      return FileText;
    default:
      return FileQuestion;
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

interface ExtraContextInputProps {
  /** Freeform prompt shown above the textarea. */
  label?: string;
  /** Placeholder for the textarea. */
  placeholder?: string;
  /** Current notes value (controlled). */
  notes: string;
  onNotesChange: (v: string) => void;
  /** Current selected files (controlled). */
  files: File[];
  onFilesChange: (files: File[]) => void;
  /** Current URL list (controlled). If omitted, URL input is hidden. */
  urls?: string[];
  onUrlsChange?: (urls: string[]) => void;
  /** Max total files — surfaced as a hint only; server enforces. */
  maxFiles?: number;
  maxUrls?: number;
  disabled?: boolean;
  /** Render collapsed initially with a "Add context" pill. */
  collapsible?: boolean;
}

export function ExtraContextInput({
  label = "Extra context for Basil",
  placeholder = "Paste notes, questions, background, anything Basil should weigh…",
  notes,
  onNotesChange,
  files,
  onFilesChange,
  urls,
  onUrlsChange,
  maxFiles = 25,
  maxUrls = 10,
  disabled = false,
  collapsible = true,
}: ExtraContextInputProps) {
  const [open, setOpen] = useState(!collapsible);
  const [dragActive, setDragActive] = useState(false);
  const [pendingUrl, setPendingUrl] = useState("");
  const [urlError, setUrlError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const urlsEnabled = Array.isArray(urls) && typeof onUrlsChange === "function";

  function addFiles(incoming: FileList | File[] | null) {
    if (!incoming) return;
    const list = incoming instanceof FileList ? Array.from(incoming) : incoming;
    if (list.length === 0) return;
    const next = [...files];
    for (const f of list) {
      if (next.length >= maxFiles) break;
      // De-dupe by name+size
      if (next.some((existing) => existing.name === f.name && existing.size === f.size)) {
        continue;
      }
      // Skip obvious junk files from folder scans
      if (f.name.startsWith(".") || f.name.endsWith(".DS_Store")) continue;
      if (f.size === 0) continue;
      next.push(f);
    }
    onFilesChange(next);
  }

  function removeAt(idx: number) {
    onFilesChange(files.filter((_, i) => i !== idx));
  }

  function addUrl() {
    const raw = pendingUrl.trim();
    if (!raw) return;
    if (!isValidHttpUrl(raw)) {
      setUrlError("Needs to be an http:// or https:// URL");
      return;
    }
    if (!urlsEnabled) return;
    const current = urls as string[];
    if (current.includes(raw)) {
      setUrlError("Already added");
      return;
    }
    if (current.length >= maxUrls) {
      setUrlError(`Max ${maxUrls} URLs`);
      return;
    }
    (onUrlsChange as (v: string[]) => void)([...current, raw]);
    setPendingUrl("");
    setUrlError("");
  }

  function removeUrl(idx: number) {
    if (!urlsEnabled) return;
    const current = urls as string[];
    (onUrlsChange as (v: string[]) => void)(current.filter((_, i) => i !== idx));
  }

  // Handle pasted images / text from clipboard. Text paste falls through to
  // default textarea behaviour; only intercept when files are present.
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const pasted: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== "file") continue;
      const f = item.getAsFile();
      if (!f) continue;
      // Clipboard screenshots come through as "image.png" with a blank name —
      // give them a timestamped name so the chip is useful.
      const safeName =
        f.name && f.name !== "image.png"
          ? f.name
          : `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      pasted.push(new File([f], safeName, { type: f.type }));
    }
    if (pasted.length > 0) {
      e.preventDefault();
      addFiles(pasted);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (disabled) return;
    const dt = e.dataTransfer;
    if (!dt) return;

    // Files path
    if (dt.files && dt.files.length > 0) {
      addFiles(dt.files);
    }
    // Dragged-in URL path (links from other tabs, Finder items with URLs, etc.)
    if (urlsEnabled) {
      const uriList = dt.getData("text/uri-list") || dt.getData("text/plain");
      if (uriList) {
        const maybeUrl = uriList.split(/\s+/).find((t) => isValidHttpUrl(t));
        if (maybeUrl) {
          const current = urls as string[];
          if (!current.includes(maybeUrl) && current.length < maxUrls) {
            (onUrlsChange as (v: string[]) => void)([...current, maybeUrl]);
          }
        }
      }
    }
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!dragActive) setDragActive(true);
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }

  const hasContent =
    notes.trim().length > 0 ||
    files.length > 0 ||
    (urlsEnabled && (urls as string[]).length > 0);

  if (collapsible && !open) {
    const bits: string[] = [];
    if (notes.trim()) bits.push("notes");
    if (files.length) bits.push(`${files.length} file${files.length === 1 ? "" : "s"}`);
    if (urlsEnabled && (urls as string[]).length)
      bits.push(
        `${(urls as string[]).length} URL${(urls as string[]).length === 1 ? "" : "s"}`
      );
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-dashed border-border bg-transparent px-3 py-1.5 text-[12px] font-medium text-muted-foreground hover:border-[oklch(0.72_0.15_85)]/60 hover:text-foreground transition",
          hasContent && "border-[oklch(0.72_0.15_85)]/60 text-foreground"
        )}
      >
        <Paperclip className="h-3.5 w-3.5" />
        {hasContent ? `Extra context (${bits.join(", ")})` : "Add extra context"}
      </button>
    );
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      className={cn(
        "relative rounded-xl ring-1 bg-background/50 p-4 space-y-3 transition",
        dragActive
          ? "ring-2 ring-[oklch(0.72_0.15_85)] bg-[oklch(0.72_0.15_85)]/5"
          : "ring-border"
      )}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-[oklch(0.72_0.15_85)]/10 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 rounded-full bg-[oklch(0.72_0.15_85)] px-4 py-2 text-[oklch(0.18_0.04_250)] text-sm font-semibold">
            <UploadCloud className="h-4 w-4" />
            Drop to attach
          </div>
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">{label}</p>
          <p className="text-[12px] text-muted-foreground">
            Type notes, drag files in, paste a screenshot, or add a URL. Word, PowerPoint, Excel, PDFs, images — all supported.
          </p>
        </div>
        {collapsible && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Hide extra context"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <Textarea
        value={notes}
        onChange={(e) => onNotesChange(e.target.value)}
        onPaste={handlePaste}
        placeholder={placeholder}
        rows={3}
        disabled={disabled}
        className="min-h-20"
      />

      {urlsEnabled && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={pendingUrl}
                onChange={(e) => {
                  setPendingUrl(e.target.value);
                  setUrlError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addUrl();
                  }
                }}
                placeholder="Paste a URL — article, doc, landing page…"
                className="pl-9"
                disabled={disabled}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addUrl}
              disabled={disabled || !pendingUrl.trim()}
              className="gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />
              Add URL
            </Button>
          </div>
          {urlError && (
            <p className="text-[12px] text-destructive">{urlError}</p>
          )}
          {(urls as string[]).length > 0 && (
            <ul className="space-y-1.5">
              {(urls as string[]).map((u, i) => (
                <li
                  key={`${u}-${i}`}
                  className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-[12px] text-foreground/80"
                >
                  <LinkIcon className="h-3.5 w-3.5 shrink-0 text-[oklch(0.58_0.15_85)]" />
                  <span className="truncate flex-1" title={u}>
                    {u}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeUrl(i)}
                    className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                    aria-label={`Remove ${u}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={disabled}
          className="gap-1.5"
        >
          <Paperclip className="h-3.5 w-3.5" />
          Add files
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => folderRef.current?.click()}
          disabled={disabled}
          className="gap-1.5"
        >
          <Folder className="h-3.5 w-3.5" />
          Add folder
        </Button>
        <span className="text-[12px] text-muted-foreground ml-auto">
          {files.length}/{maxFiles} files · Drag & drop, paste images, URLs all work
        </span>

        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            if (fileRef.current) fileRef.current.value = "";
          }}
        />
        <input
          ref={folderRef}
          type="file"
          webkitdirectory=""
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            if (folderRef.current) folderRef.current.value = "";
          }}
        />
      </div>

      {files.length > 0 && (
        <ul className="space-y-1.5">
          {files.map((f, i) => {
            const k = kind(f);
            const Icon = iconFor(k);
            const unsupported = k === "other";
            return (
              <li
                key={`${f.name}-${f.size}-${i}`}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px]",
                  unsupported
                    ? "bg-destructive/5 text-destructive"
                    : "bg-muted/50 text-foreground/80"
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate flex-1" title={f.name}>
                  {f.name}
                </span>
                <span className="font-mono text-[12px] opacity-70 shrink-0">
                  {humanSize(f.size)}
                </span>
                {unsupported && (
                  <span className="shrink-0 font-medium">unsupported</span>
                )}
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                  aria-label={`Remove ${f.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Convenience builder: turn state into a FormData for the generate routes. */
export function buildExtraContextFormData(
  notes: string,
  files: File[],
  extraFields?: Record<string, string | string[] | object>,
  urls?: string[]
): FormData {
  const fd = new FormData();
  if (notes.trim()) fd.set("notes", notes.trim());
  for (const f of files) fd.append("files", f);
  if (urls) for (const u of urls) if (u.trim()) fd.append("urls", u.trim());
  if (extraFields) {
    for (const [k, v] of Object.entries(extraFields)) {
      if (typeof v === "string") fd.set(k, v);
      else fd.set(k, JSON.stringify(v));
    }
  }
  return fd;
}
