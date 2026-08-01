import { useEffect, useMemo, useRef, useState } from 'react';
import { Breadcrumbs } from './components/Breadcrumbs';
import { DistillPanel } from './components/DistillPanel';
import { NoteTree, type NoteHandlers } from './components/NoteTree';
import { copyText } from './lib/clipboard';
import * as N from './lib/notes';
import { distill, type DistillResult } from './services/distiller';
import type { Note } from './types';

const STORAGE_KEY = 'fractal-notes-distill:v1';

function seed(): Note {
  const b = (text: string, children: Note[] = []): Note => ({ id: N.uid(), text, children });
  return {
    id: N.uid(),
    text: 'Home',
    children: [
      b('Welcome to Fractal Notes 🌀', [
        b('Every bullet is a page of its own — click its dot to zoom in.'),
        b('Enter adds a note, Tab indents, Shift+Tab outdents.'),
        b('Backspace on an empty note deletes it; the chevron collapses a branch.'),
      ]),
      b('Distill any branch ✨', [
        b('Zoom into a branch, then press Distill to reduce it to its essence.'),
        b('With a GEMINI_API_KEY configured, distillation uses Gemini.'),
        b('Without a key it still works — an offline summarizer picks the key points.'),
      ]),
      b('Sample project: community garden site', [
        b('Goal: launch the garden association website before the June open day.'),
        b('Audience: neighbours, volunteers, and the city grants office.'),
        b('Content', [
          b('Plot map and waiting-list signup form.'),
          b('Seasonal planting calendar written by the volunteers.'),
          b('Photo gallery from last year’s harvest festival.'),
        ]),
        b('Tasks', [
          b('Compare static site hosts and pick one by Friday.'),
          b('Draft the signup form fields with the membership team.'),
          b('Ask Priya for the harvest festival photos.'),
        ]),
        b('Open question: do we need bilingual pages for the grants office?'),
      ]),
    ],
  };
}

function loadRoot(): Note {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Note;
      if (parsed && typeof parsed.id === 'string' && Array.isArray(parsed.children)) {
        return parsed;
      }
    }
  } catch {
    // Corrupted or unavailable storage falls through to the seed outline.
  }
  return seed();
}

interface FocusRequest {
  id: string;
  caret: number | 'end';
}

export default function App() {
  const [root, setRoot] = useState<Note>(loadRoot);
  const [zoomId, setZoomId] = useState<string>(() => root.id);
  const [result, setResult] = useState<DistillResult | null>(null);
  const [distilling, setDistilling] = useState(false);
  const [copied, setCopied] = useState(false);

  const inputRefs = useRef(new Map<string, HTMLInputElement>());
  const pendingFocus = useRef<FocusRequest | null>(null);

  const path = useMemo(() => N.findPath(root, zoomId) ?? [root], [root, zoomId]);
  const zoomRoot = path[path.length - 1];
  const noteCount = useMemo(() => N.countNotes(zoomRoot), [zoomRoot]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(root));
    } catch {
      // Storage may be full or unavailable; the in-memory tree still works.
    }
  }, [root]);

  useEffect(() => {
    const req = pendingFocus.current;
    if (!req) return;
    pendingFocus.current = null;
    const el = inputRefs.current.get(req.id);
    if (!el) return;
    el.focus();
    const pos = req.caret === 'end' ? el.value.length : req.caret;
    el.setSelectionRange(pos, pos);
  });

  const registerInput = (id: string) => (el: HTMLInputElement | null) => {
    if (el) inputRefs.current.set(id, el);
    else inputRefs.current.delete(id);
  };

  const requestFocus = (id: string, caret: number | 'end' = 'end') => {
    pendingFocus.current = { id, caret };
  };

  const focusNow = (id: string) => {
    const el = inputRefs.current.get(id);
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  };

  const setText = (id: string, text: string) => setRoot(r => N.updateNode(r, id, { text }));

  const toggleCollapse = (id: string) =>
    setRoot(r => N.updateNode(r, id, n => ({ ...n, collapsed: !n.collapsed })));

  const zoomTo = (id: string) => {
    setResult(null);
    setZoomId(id);
    requestFocus(id);
  };

  const addNote = (parentId: string) => {
    const note = N.createNote('');
    setRoot(r => N.insertChild(r, parentId, note, N.findNode(r, parentId)?.children.length ?? 0));
    requestFocus(note.id, 0);
  };

  const handleEnter = (id: string) => {
    const note = N.createNote('');
    setRoot(r => {
      const target = N.findNode(r, id);
      if (!target) return r;
      if (id === zoomRoot.id || (target.children.length > 0 && !target.collapsed)) {
        return N.insertChild(r, id, note, 0);
      }
      return N.insertSiblingAfter(r, id, note);
    });
    requestFocus(note.id, 0);
  };

  const handleIndent = (id: string, caret: number) => {
    setRoot(r => N.indentNode(r, id));
    requestFocus(id, caret);
  };

  const handleOutdent = (id: string, caret: number) => {
    const inZoom = N.findPath(zoomRoot, id);
    if (!inZoom || inZoom.length < 3) return;
    setRoot(r => N.outdentNode(r, id));
    requestFocus(id, caret);
  };

  const handleDeleteEmpty = (id: string) => {
    const node = N.findNode(root, id);
    if (!node || node.children.length > 0) return;
    const visible = N.flattenVisible(zoomRoot);
    const index = visible.findIndex(n => n.id === id);
    const prevId = index > 0 ? visible[index - 1].id : zoomRoot.id;
    setRoot(r => N.removeNode(r, id));
    requestFocus(prevId, 'end');
  };

  const handleArrow = (id: string, dir: -1 | 1) => {
    const ids = [zoomRoot.id, ...N.flattenVisible(zoomRoot).map(n => n.id)];
    const index = ids.indexOf(id);
    const nextId = ids[index + dir];
    if (nextId) focusNow(nextId);
  };

  const handlers: NoteHandlers = {
    registerInput,
    onText: setText,
    onToggle: toggleCollapse,
    onZoom: zoomTo,
    onEnter: handleEnter,
    onIndent: handleIndent,
    onOutdent: handleOutdent,
    onDeleteEmpty: handleDeleteEmpty,
    onArrow: handleArrow,
  };

  const runDistill = async () => {
    if (distilling) return;
    setDistilling(true);
    try {
      setResult(await distill(zoomRoot));
    } finally {
      setDistilling(false);
    }
  };

  const markdown = () => N.toMarkdown(zoomRoot);

  const copyMarkdown = async () => {
    setCopied(await copyText(markdown()));
    window.setTimeout(() => setCopied(false), 1500);
  };

  const downloadMarkdown = () => {
    const name =
      (zoomRoot.text.trim() || 'fractal-notes')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'fractal-notes';
    const blob = new Blob([markdown() + '\n'], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`app${result ? ' with-panel' : ''}`}>
      <header className="topbar">
        <button className="brand" onClick={() => zoomTo(root.id)}>
          🌀 <span>Fractal Notes</span>
        </button>
        <Breadcrumbs path={path} onZoom={zoomTo} />
        <div className="actions">
          <span className="count">
            {noteCount} {noteCount === 1 ? 'note' : 'notes'}
          </span>
          <button className="btn ghost" onClick={copyMarkdown}>
            {copied ? 'Copied!' : 'Copy MD'}
          </button>
          <button className="btn ghost" onClick={downloadMarkdown}>
            Export .md
          </button>
          <button className="btn primary" onClick={runDistill} disabled={distilling}>
            {distilling ? 'Distilling…' : '✨ Distill'}
          </button>
        </div>
      </header>
      <div className="layout">
        <main className="page">
          <input
            className="page-title"
            ref={registerInput(zoomRoot.id)}
            value={zoomRoot.text}
            placeholder={zoomRoot.id === root.id ? 'Home' : 'Untitled'}
            onChange={e => setText(zoomRoot.id, e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleEnter(zoomRoot.id);
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                handleArrow(zoomRoot.id, 1);
              }
            }}
          />
          {zoomRoot.children.length === 0 ? (
            <div className="empty">
              <p>This page is empty.</p>
              <button className="btn" onClick={() => addNote(zoomRoot.id)}>
                + Add a note
              </button>
            </div>
          ) : (
            <>
              <NoteTree parent={zoomRoot} handlers={handlers} />
              <button className="add-row" onClick={() => addNote(zoomRoot.id)}>
                + New note
              </button>
            </>
          )}
          <footer className="hints">
            <span>
              <kbd>Enter</kbd> new note
            </span>
            <span>
              <kbd>Tab</kbd>/<kbd>Shift+Tab</kbd> indent/outdent
            </span>
            <span>
              <kbd>Backspace</kbd> on empty deletes
            </span>
            <span>
              click a <b>•</b> to zoom in
            </span>
          </footer>
        </main>
        {result && (
          <DistillPanel
            result={result}
            title={zoomRoot.text.trim() || 'Untitled'}
            onClose={() => setResult(null)}
          />
        )}
      </div>
    </div>
  );
}
