"use client";

/**
 * Markdown — a tiny, dependency-free, XSS-safe markdown renderer.
 *
 * The assistant persona naturally emits markdown (bold, headings, bullets,
 * links, code). Rendering it as `whitespace-pre-wrap` text showed the literal
 * syntax (`**bold**`, `### heading`), which undercut the premium feel. This
 * renders a conservative subset to real React elements — text is always escaped
 * by React (no innerHTML), so there is no injection surface. Anything it doesn't
 * recognise falls through as plain text.
 *
 * Supported: # / ## / ### headings, - * • bullets, 1. ordered lists, > quotes,
 * ``` fenced code, and inline **bold**, *italic* / _italic_, `code`, [text](url).
 */

import React from "react";

// ── Inline spans ────────────────────────────────────────────────────────────
// Order matters: code first (so its contents aren't re-parsed), then links,
// then bold, then italic.
const INLINE = [
  { re: /`([^`]+)`/, render: (m: string, key: number) => <code key={key} className="rounded bg-white/10 px-1 py-0.5 text-[0.85em] font-mono">{m}</code> },
  { re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/, render: (m: string, key: number, g2?: string) => <a key={key} href={g2} target="_blank" rel="noopener noreferrer" className="text-[var(--w-carbon)] underline underline-offset-2 hover:opacity-80">{m}</a> },
  { re: /\*\*([^*]+)\*\*/, render: (m: string, key: number) => <strong key={key} className="font-semibold">{m}</strong> },
  { re: /(?<![\w*])\*([^*\n]+)\*(?![\w*])/, render: (m: string, key: number) => <em key={key}>{m}</em> },
  { re: /(?<![\w_])_([^_\n]+)_(?![\w_])/, render: (m: string, key: number) => <em key={key}>{m}</em> },
];

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let rest = text;
  let k = 0;
  // Repeatedly find the earliest-matching inline token and split around it.
  // Bounded by rest shrinking each pass; falls out when nothing matches.
  while (rest.length > 0) {
    let best: { idx: number; len: number; node: React.ReactNode } | null = null;
    for (const { re, render } of INLINE) {
      const m = re.exec(rest);
      if (m && (best === null || m.index < best.idx)) {
        best = { idx: m.index, len: m[0].length, node: render(m[1], k, m[2]) };
      }
    }
    if (!best) { out.push(rest); break; }
    if (best.idx > 0) out.push(rest.slice(0, best.idx));
    out.push(best.node);
    rest = rest.slice(best.idx + best.len);
    k++;
  }
  return out.map((n, i) => (typeof n === "string" ? <React.Fragment key={`${keyBase}-t${i}`}>{n}</React.Fragment> : n));
}

// ── Block parser ────────────────────────────────────────────────────────────

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length === 0) return;
    blocks.push(<p key={`p${key++}`} className="leading-relaxed">{renderInline(buf.join(" "), `p${key}`)}</p>);
    buf.length = 0;
  };

  const para: string[] = [];
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line.trim())) {
      flushParagraph(para);
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { code.push(lines[i]); i++; }
      i++; // consume closing fence
      blocks.push(<pre key={`c${key++}`} className="my-2 overflow-x-auto rounded-md bg-white/[0.06] p-3 text-[0.8rem] font-mono leading-relaxed"><code>{code.join("\n")}</code></pre>);
      continue;
    }

    // Headings
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushParagraph(para);
      const level = h[1].length;
      const cls = level === 1 ? "text-base font-semibold mt-3" : level === 2 ? "text-sm font-semibold mt-3" : "text-sm font-medium mt-2";
      blocks.push(<p key={`h${key++}`} className={cls}>{renderInline(h[2], `h${key}`)}</p>);
      i++; continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      flushParagraph(para);
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, "")); i++; }
      blocks.push(<blockquote key={`q${key++}`} className="border-l-2 border-border pl-3 text-muted-foreground italic">{renderInline(quote.join(" "), `q${key}`)}</blockquote>);
      continue;
    }

    // Unordered list
    if (/^\s*[-*•]\s+/.test(line)) {
      flushParagraph(para);
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*•]\s+/, "")); i++; }
      blocks.push(<ul key={`u${key++}`} className="my-1 ml-4 list-disc space-y-1">{items.map((it, j) => <li key={j} className="leading-relaxed">{renderInline(it, `u${key}-${j}`)}</li>)}</ul>);
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushParagraph(para);
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, "")); i++; }
      blocks.push(<ol key={`o${key++}`} className="my-1 ml-4 list-decimal space-y-1">{items.map((it, j) => <li key={j} className="leading-relaxed">{renderInline(it, `o${key}-${j}`)}</li>)}</ol>);
      continue;
    }

    // Blank line ends a paragraph
    if (line.trim() === "") { flushParagraph(para); i++; continue; }

    // Otherwise accumulate into the current paragraph
    para.push(line);
    i++;
  }
  flushParagraph(para);

  return <div className={`space-y-2 text-sm ${className}`}>{blocks}</div>;
}
