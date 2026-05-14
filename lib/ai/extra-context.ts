// Shared extra-context ingestion for Briefing + Meeting Prep.
//
// Michael can paste free-text, upload files, drop a folder, paste screenshots,
// or hand over URLs. This util accepts a FormData payload and returns a
// normalised shape that the generate routes fold into their prompts:
//
//   - notes          — free-text pasted by Michael (verbatim)
//   - textBlock      — concatenated contents of: uploaded text-like files,
//                      extracted Word/Excel/PowerPoint, and fetched URLs
//   - fileParts      — AI SDK file content-parts (PDFs + images) to attach to
//                      the user message, so Claude can actually read them
//   - skipped        — filenames / URLs we couldn't use
//
// Design principle: never silently drop signal. If something can't be parsed
// we flag it so the route can mention it in the prompt ("Michael also attached
// X but it wasn't supported") or the UI can show it back to the user.

import {
  parseOffice,
  type OfficeContentNode,
  type OfficeParserAST,
} from "officeparser";

/**
 * Flatten an officeparser AST into plain text. We walk depth-first, emitting
 * each node's `text` where present and recursing into children. Top-level and
 * block-ish nodes get newlines around them so paragraphs, headings, and slide
 * content don't run into each other.
 */
function astToText(ast: OfficeParserAST): string {
  const BLOCK_TYPES = new Set([
    "paragraph",
    "heading",
    "listItem",
    "list",
    "table",
    "row",
    "cell",
    "slide",
    "page",
    "section",
  ]);

  const parts: string[] = [];

  const walk = (node: OfficeContentNode, depth: number) => {
    const isBlock = BLOCK_TYPES.has(node.type as string);
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;

    if (node.text && !hasChildren) {
      parts.push(node.text);
    }

    if (hasChildren) {
      for (const child of node.children!) walk(child, depth + 1);
    }

    if (isBlock) parts.push("\n");
  };

  for (const node of ast.content || []) walk(node, 0);

  return parts
    .join(" ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const MAX_TEXT_FILE_BYTES = 128 * 1024; // 128KB per text file
export const MAX_OFFICE_FILE_BYTES = 10 * 1024 * 1024; // 10MB per Office doc
export const MAX_TOTAL_TEXT_BYTES = 1024 * 1024; // 1MB aggregate text budget
export const MAX_BINARY_FILE_BYTES = 3 * 1024 * 1024; // 3MB per PDF/image — hard cap before Vercel's 4.5MB body limit
export const MAX_FILES = 25;
export const MAX_URLS = 10;
export const MAX_URL_BYTES = 2 * 1024 * 1024; // 2MB per fetched page
export const URL_FETCH_TIMEOUT_MS = 12_000;
export const MAX_URL_EXTRACTED_CHARS = 50_000; // cap per URL into the prompt

const TEXT_EXTENSIONS = new Set([
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

const OFFICE_EXTENSIONS = new Set([
  "docx",
  "doc", // officeparser will still try; most .doc files fail — that's honest
  "xlsx",
  "xls",
  "xlsm",
  "pptx",
  "ppt",
  "odt",
  "ods",
  "odp",
]);

const IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export interface FilePart {
  type: "file";
  data: Uint8Array;
  mediaType: string;
  filename: string;
}

export interface ExtraContext {
  notes: string;
  textBlock: string; // already formatted, ready to splice into a prompt
  fileParts: FilePart[];
  skipped: Array<{ name: string; reason: string }>;
  summary: string; // one-line human summary for logs / debug
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

function isTextLike(file: File): boolean {
  if (TEXT_EXTENSIONS.has(extensionOf(file.name))) return true;
  // application/json, text/*, etc. are text-safe too
  return (
    file.type.startsWith("text/") ||
    file.type === "application/json" ||
    file.type === "application/xml"
  );
}

function isOfficeDoc(file: File): boolean {
  if (OFFICE_EXTENSIONS.has(extensionOf(file.name))) return true;
  // MIME covers the common Office types
  return (
    file.type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    file.type ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    file.type ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    file.type === "application/msword" ||
    file.type === "application/vnd.ms-excel" ||
    file.type === "application/vnd.ms-powerpoint" ||
    file.type === "application/vnd.oasis.opendocument.text" ||
    file.type === "application/vnd.oasis.opendocument.spreadsheet" ||
    file.type === "application/vnd.oasis.opendocument.presentation"
  );
}

function officeKindLabel(file: File): string {
  const ext = extensionOf(file.name);
  if (["docx", "doc", "odt"].includes(ext)) return "Word document";
  if (["xlsx", "xls", "xlsm", "ods"].includes(ext)) return "spreadsheet";
  if (["pptx", "ppt", "odp"].includes(ext)) return "presentation";
  return "Office document";
}

/**
 * Strip HTML down to readable text. Good enough for briefing/prep context —
 * we're not rendering, just feeding the model a compact textual view.
 */
function htmlToText(html: string): string {
  return (
    html
      // Drop scripts/styles entirely
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
      // Turn block-level closers into newlines so paragraphs stay paragraphs
      .replace(/<\/(p|div|section|article|li|h[1-6]|br|tr|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      // Strip remaining tags
      .replace(/<[^>]+>/g, "")
      // Decode a handful of common entities; don't try to be exhaustive
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&apos;/gi, "'")
      // Collapse whitespace
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n\s*\n+/g, "\n\n")
      .trim()
  );
}

async function fetchUrl(raw: string): Promise<
  | { ok: true; text: string; title?: string; finalUrl: string }
  | { ok: false; reason: string }
> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported scheme ${url.protocol}` };
  }
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
    const res = await fetch(url.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // Identify as a browser-ish client to avoid the worst bot-gates; many
        // sites still block us, that's fine — we surface the failure honestly.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
    });
    clearTimeout(t);
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const ct = res.headers.get("content-type") || "";
    // Length guard — some pages are huge
    const lenHeader = res.headers.get("content-length");
    if (lenHeader && Number(lenHeader) > MAX_URL_BYTES) {
      return {
        ok: false,
        reason: `page >${Math.round(MAX_URL_BYTES / (1024 * 1024))}MB`,
      };
    }
    const raw = await res.text();
    if (raw.length > MAX_URL_BYTES) {
      return {
        ok: false,
        reason: `page >${Math.round(MAX_URL_BYTES / (1024 * 1024))}MB`,
      };
    }
    if (!ct.includes("text/") && !ct.includes("html") && !ct.includes("xml")) {
      // Non-textual response — bail rather than feeding gibberish to the model
      return { ok: false, reason: `non-text response (${ct || "unknown"})` };
    }
    const titleMatch = raw.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    const title = titleMatch?.[1]?.trim();
    let text = ct.includes("html") || ct.includes("xml") ? htmlToText(raw) : raw;
    if (text.length > MAX_URL_EXTRACTED_CHARS) {
      text = text.slice(0, MAX_URL_EXTRACTED_CHARS) + "\n\n…[truncated]";
    }
    return { ok: true, text, title, finalUrl: res.url || url.toString() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    return { ok: false, reason: msg.includes("abort") ? "timed out" : msg };
  }
}

function isPdf(file: File): boolean {
  return (
    file.type === "application/pdf" || extensionOf(file.name) === "pdf"
  );
}

function isImage(file: File): boolean {
  if (IMAGE_MIME.has(file.type)) return true;
  const ext = extensionOf(file.name);
  return ["png", "jpg", "jpeg", "webp", "gif"].includes(ext);
}

function mimeForImage(file: File): string {
  if (file.type && IMAGE_MIME.has(file.type)) return file.type;
  const ext = extensionOf(file.name);
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "application/octet-stream";
}

/**
 * Parse a multipart form that contains an optional `notes` text field, zero
 * or more `files` entries, and zero or more `urls` entries. Returns a
 * structure ready to splice into a generateText() call.
 */
export async function parseExtraContext(
  formData: FormData
): Promise<ExtraContext> {
  const notes = (formData.get("notes") as string | null)?.trim() ?? "";

  // Collect files — Browser sends multiple values under the same key.
  const fileEntries = formData.getAll("files").filter(
    (v): v is File => v instanceof File
  );

  // URLs can arrive as repeated "urls" fields OR as a single comma/newline
  // separated "urls" string — accept either.
  const urlCandidates: string[] = [];
  for (const raw of formData.getAll("urls")) {
    if (typeof raw !== "string") continue;
    for (const piece of raw.split(/[\n,]+/)) {
      const trimmed = piece.trim();
      if (trimmed) urlCandidates.push(trimmed);
    }
  }
  const dedupedUrls = [...new Set(urlCandidates)].slice(0, MAX_URLS);

  const textChunks: string[] = [];
  const fileParts: FilePart[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  let totalTextBytes = 0;
  let filesProcessed = 0;
  let officeFilesParsed = 0;
  let urlsFetched = 0;

  for (const file of fileEntries) {
    if (filesProcessed >= MAX_FILES) {
      skipped.push({ name: file.name, reason: `exceeded max of ${MAX_FILES} files` });
      continue;
    }

    // Silently skip clearly-useless entries (hidden files, empty files)
    if (file.size === 0) continue;
    if (file.name.startsWith(".")) continue;
    if (file.name.endsWith(".DS_Store")) continue;

    try {
      if (isTextLike(file)) {
        if (file.size > MAX_TEXT_FILE_BYTES) {
          skipped.push({
            name: file.name,
            reason: `text file >${Math.round(MAX_TEXT_FILE_BYTES / 1024)}KB — truncated not attempted`,
          });
          continue;
        }
        if (totalTextBytes + file.size > MAX_TOTAL_TEXT_BYTES) {
          skipped.push({
            name: file.name,
            reason: "total text budget reached",
          });
          continue;
        }
        const text = await file.text();
        textChunks.push(`### FILE: ${file.name}\n\n${text.trim()}`);
        totalTextBytes += file.size;
        filesProcessed++;
      } else if (isOfficeDoc(file)) {
        if (file.size > MAX_OFFICE_FILE_BYTES) {
          skipped.push({
            name: file.name,
            reason: `Office doc >${Math.round(MAX_OFFICE_FILE_BYTES / (1024 * 1024))}MB`,
          });
          continue;
        }
        const buf = Buffer.from(await file.arrayBuffer());
        let extracted = "";
        try {
          const ast = await parseOffice(buf);
          extracted = astToText(ast);
        } catch (e) {
          skipped.push({
            name: file.name,
            reason: `${officeKindLabel(file)} parse failed: ${e instanceof Error ? e.message : "unknown"}`,
          });
          continue;
        }
        if (!extracted) {
          skipped.push({
            name: file.name,
            reason: `${officeKindLabel(file)} had no extractable text`,
          });
          continue;
        }
        // Truncate extracted text to avoid blowing the aggregate budget
        const capBytes = MAX_TOTAL_TEXT_BYTES - totalTextBytes;
        if (capBytes <= 0) {
          skipped.push({
            name: file.name,
            reason: "total text budget reached",
          });
          continue;
        }
        if (extracted.length > capBytes) {
          extracted = extracted.slice(0, capBytes) + "\n\n…[truncated]";
        }
        textChunks.push(
          `### ${officeKindLabel(file).toUpperCase()}: ${file.name}\n\n${extracted}`
        );
        totalTextBytes += Math.min(extracted.length, capBytes);
        filesProcessed++;
        officeFilesParsed++;
      } else if (isPdf(file) || isImage(file)) {
        if (file.size > MAX_BINARY_FILE_BYTES) {
          skipped.push({
            name: file.name,
            reason: `file >${Math.round(MAX_BINARY_FILE_BYTES / (1024 * 1024))}MB`,
          });
          continue;
        }
        const buf = new Uint8Array(await file.arrayBuffer());
        const mediaType = isPdf(file) ? "application/pdf" : mimeForImage(file);
        fileParts.push({
          type: "file",
          data: buf,
          mediaType,
          filename: file.name,
        });
        filesProcessed++;
      } else {
        skipped.push({
          name: file.name,
          reason: `unsupported type (${file.type || extensionOf(file.name) || "unknown"})`,
        });
      }
    } catch (e) {
      skipped.push({
        name: file.name,
        reason: `read error: ${e instanceof Error ? e.message : "unknown"}`,
      });
    }
  }

  // Fetch URLs in parallel — each bounded by URL_FETCH_TIMEOUT_MS
  if (dedupedUrls.length > 0) {
    const fetches = await Promise.all(dedupedUrls.map((u) => fetchUrl(u)));
    for (let i = 0; i < dedupedUrls.length; i++) {
      const u = dedupedUrls[i];
      const res = fetches[i];
      if (!res.ok) {
        skipped.push({ name: u, reason: res.reason });
        continue;
      }
      const remaining = MAX_TOTAL_TEXT_BYTES - totalTextBytes;
      if (remaining <= 0) {
        skipped.push({ name: u, reason: "total text budget reached" });
        continue;
      }
      let text = res.text;
      if (text.length > remaining) text = text.slice(0, remaining) + "\n\n…[truncated]";
      const header = res.title
        ? `### URL: ${res.finalUrl} — "${res.title}"`
        : `### URL: ${res.finalUrl}`;
      textChunks.push(`${header}\n\n${text}`);
      totalTextBytes += text.length;
      urlsFetched++;
    }
  }

  const textBlock = textChunks.length
    ? textChunks.join("\n\n---\n\n")
    : "";

  const summaryParts: string[] = [];
  if (notes) summaryParts.push(`${notes.length} chars of notes`);
  const textFileCount = textChunks.length - officeFilesParsed - urlsFetched;
  if (textFileCount > 0) summaryParts.push(`${textFileCount} text file(s)`);
  if (officeFilesParsed) summaryParts.push(`${officeFilesParsed} Office file(s)`);
  if (fileParts.length) summaryParts.push(`${fileParts.length} binary file(s)`);
  if (urlsFetched) summaryParts.push(`${urlsFetched} URL(s)`);
  if (skipped.length) summaryParts.push(`${skipped.length} skipped`);
  const summary = summaryParts.join(", ") || "no extra context";

  return { notes, textBlock, fileParts, skipped, summary };
}

/**
 * Build the "## EXTRA CONTEXT" block for a prompt. Returns empty string if
 * nothing was supplied so prompts stay clean when unused.
 */
export function formatExtraContextBlock(ctx: ExtraContext): string {
  if (!ctx.notes && !ctx.textBlock && ctx.fileParts.length === 0) return "";

  const parts: string[] = [];
  parts.push(
    "## EXTRA CONTEXT FROM MICHAEL",
    "Michael attached this context for you to weigh when you write. Treat it as LIVE DATA — on par with the other data blocks above. Quote from it when useful. Never invent beyond it.",
    ""
  );

  if (ctx.notes) {
    parts.push("### Michael's notes", ctx.notes, "");
  }

  if (ctx.textBlock) {
    parts.push("### Attached text files", ctx.textBlock, "");
  }

  if (ctx.fileParts.length > 0) {
    const names = ctx.fileParts.map((p) => p.filename).join(", ");
    parts.push(
      `### Attached files for you to read: ${names}`,
      "(Contents are attached as file parts on this same message — read them directly.)",
      ""
    );
  }

  if (ctx.skipped.length > 0) {
    const list = ctx.skipped
      .map((s) => `- ${s.name} (${s.reason})`)
      .join("\n");
    parts.push(
      "### Files Michael attached but Basil couldn't use",
      list,
      "(You may mention these briefly in your output if relevant — 'Michael also attached X but I couldn't parse it.')",
      ""
    );
  }

  return parts.join("\n");
}
