import { toMarkdown } from '../lib/notes';
import type { Note } from '../types';

export type DistillMode = 'gemini' | 'local';

export interface DistillResult {
  mode: DistillMode;
  summary: string;
  note?: string;
}

const STOPWORDS = new Set(
  (
    'a,an,the,and,or,but,if,then,else,of,in,on,at,to,for,with,by,from,as,is,are,was,were,be,been,' +
    'being,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,our,your,their,my,me,do,' +
    'does,did,doing,have,has,had,having,will,would,can,could,should,shall,may,might,must,not,no,' +
    'so,than,too,very,just,about,into,over,under,again,further,once,here,there,when,where,why,how,' +
    'all,any,both,each,few,more,most,other,some,such,only,own,same,up,down,out,off,also,what,which,' +
    'who,whom,while,because,until,before,after,between,during,through,dont,doesnt,didnt,isnt,arent,' +
    'im,ive,youre,theyre,weve,its,thats,get,got,need,needs,make,use'
  ).split(',')
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map(word => word.replace(/^['-]+|['-]+$/g, ''))
    .filter(word => word.length > 1 && !STOPWORDS.has(word));
}

/**
 * Extractive fallback summarizer: scores every note by how strongly it carries
 * the branch's recurring vocabulary, then keeps the top lines in document order.
 * Deterministic, dependency-free, and runs entirely in the browser.
 */
export function distillLocal(root: Note): string {
  const items: { text: string; depth: number; index: number }[] = [];
  const walk = (note: Note, depth: number) => {
    for (const child of note.children) {
      const text = child.text.trim();
      if (text) items.push({ text, depth, index: items.length });
      walk(child, depth + 1);
    }
  };
  walk(root, 0);

  if (items.length === 0) {
    return 'Nothing to distill yet — add a few notes to this branch first.';
  }

  const freq = new Map<string, number>();
  for (const item of items) {
    for (const word of tokenize(item.text)) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  const scored = items.map(item => {
    const words = tokenize(item.text);
    const raw = words.reduce((sum, word) => sum + (freq.get(word) ?? 0), 0);
    const score = words.length
      ? (raw / Math.sqrt(words.length)) * (1 / (1 + item.depth * 0.15))
      : 0;
    return { ...item, score };
  });

  const k = Math.max(3, Math.min(7, Math.ceil(items.length * 0.25)));
  const top = [...scored]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(k, scored.length))
    .sort((a, b) => a.index - b.index);

  const themes = [...freq.entries()]
    .filter(([word, count]) => word.length > 2 && count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([word]) => word);

  const title = root.text.trim() || 'This branch';
  const lines = [
    `**${title}** — ${items.length} note${items.length === 1 ? '' : 's'} distilled to ${top.length} key point${top.length === 1 ? '' : 's'}:`,
    '',
    ...top.map(item => `- ${item.text}`),
  ];
  if (themes.length) {
    lines.push('', `_Recurring themes: ${themes.join(', ')}_`);
  }
  return lines.join('\n');
}

function geminiApiKey(): string {
  // Replaced at build time by Vite's `define`; empty when no key is configured.
  const key = process.env.API_KEY;
  return typeof key === 'string' ? key.trim() : '';
}

export async function distill(root: Note): Promise<DistillResult> {
  const key = geminiApiKey();
  if (!key) {
    return {
      mode: 'local',
      summary: distillLocal(root),
      note: 'No Gemini API key configured — used the built-in offline summarizer.',
    };
  }
  try {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: key });
    const outline = toMarkdown(root);
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents:
        'You distill hierarchical notes. Given the Markdown outline below, reply in Markdown with:\n' +
        '1. **Essence** — one sentence capturing the whole branch.\n' +
        '2. **Key points** — 3-7 bullets, most important first.\n' +
        '3. **Open loops** — bullets for unresolved questions or action items, only if any exist.\n' +
        'Be faithful to the notes; do not invent facts.\n\n---\n\n' +
        outline,
    });
    const text = (response.text ?? '').trim();
    if (!text) throw new Error('empty response');
    return { mode: 'gemini', summary: text };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      mode: 'local',
      summary: distillLocal(root),
      note: `Gemini request failed (${reason}) — distilled offline instead.`,
    };
  }
}
