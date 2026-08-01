import { useState } from 'react';
import { copyText } from '../lib/clipboard';
import type { DistillResult } from '../services/distiller';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_(.+?)_(?=$|[\s.,;:!?])/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

// Minimal Markdown renderer for distill output: headings, bullet/numbered
// lists, bold, italics, and inline code. Input is escaped before styling.
function renderLite(md: string): string {
  const blocks: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      blocks.push(`<ul>${list.join('')}</ul>`);
      list = [];
    }
  };
  for (const rawLine of md.split('\n')) {
    const line = rawLine.trimEnd();
    const bullet = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      list.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    flush();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      blocks.push(`<h4>${inline(heading[1])}</h4>`);
      continue;
    }
    if (line.trim() === '') continue;
    blocks.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return blocks.join('');
}

interface DistillPanelProps {
  result: DistillResult;
  title: string;
  onClose: () => void;
}

export function DistillPanel({ result, title, onClose }: DistillPanelProps) {
  const [copied, setCopied] = useState(false);
  return (
    <aside className="panel" aria-label="Distillation result">
      <div className="panel-head">
        <div>
          <div className="panel-title">Distilled: {title}</div>
          <span className={`badge ${result.mode}`}>
            {result.mode === 'gemini' ? 'Gemini' : 'Offline'}
          </span>
        </div>
        <button className="btn ghost" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>
      {result.note && <p className="panel-note">{result.note}</p>}
      <div
        className="panel-body"
        dangerouslySetInnerHTML={{ __html: renderLite(result.summary) }}
      />
      <div className="panel-actions">
        <button
          className="btn ghost"
          onClick={async () => {
            setCopied(await copyText(result.summary));
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied!' : 'Copy summary'}
        </button>
      </div>
    </aside>
  );
}
