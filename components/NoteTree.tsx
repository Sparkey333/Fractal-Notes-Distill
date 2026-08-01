import type { Note } from '../types';

export interface NoteHandlers {
  registerInput: (id: string) => (el: HTMLInputElement | null) => void;
  onText: (id: string, text: string) => void;
  onToggle: (id: string) => void;
  onZoom: (id: string) => void;
  onEnter: (id: string) => void;
  onIndent: (id: string, caret: number) => void;
  onOutdent: (id: string, caret: number) => void;
  onDeleteEmpty: (id: string) => void;
  onArrow: (id: string, dir: -1 | 1) => void;
}

interface NoteTreeProps {
  parent: Note;
  handlers: NoteHandlers;
}

export function NoteTree({ parent, handlers }: NoteTreeProps) {
  return (
    <div className="tree">
      {parent.children.map(note => (
        <NoteNode key={note.id} note={note} handlers={handlers} />
      ))}
    </div>
  );
}

function NoteNode({ note, handlers }: { note: Note; handlers: NoteHandlers }) {
  const h = handlers;
  const hasChildren = note.children.length > 0;
  return (
    <div className="node">
      <div className="row">
        <button
          className={`chevron${hasChildren ? '' : ' hidden'}${note.collapsed ? ' closed' : ''}`}
          onClick={() => h.onToggle(note.id)}
          aria-label={note.collapsed ? 'Expand branch' : 'Collapse branch'}
          tabIndex={-1}
        >
          ▾
        </button>
        <button
          className={`dot${hasChildren && note.collapsed ? ' full' : ''}`}
          onClick={() => h.onZoom(note.id)}
          title="Zoom into this note"
          aria-label="Zoom into this note"
          tabIndex={-1}
        />
        <input
          ref={h.registerInput(note.id)}
          className="note-input"
          value={note.text}
          placeholder="…"
          onChange={e => h.onText(note.id, e.target.value)}
          onKeyDown={e => {
            const el = e.currentTarget;
            if (e.key === 'Enter') {
              e.preventDefault();
              h.onEnter(note.id);
            } else if (e.key === 'Tab' && !e.shiftKey) {
              e.preventDefault();
              h.onIndent(note.id, el.selectionStart ?? 0);
            } else if (e.key === 'Tab' && e.shiftKey) {
              e.preventDefault();
              h.onOutdent(note.id, el.selectionStart ?? 0);
            } else if (e.key === 'Backspace' && el.value === '') {
              e.preventDefault();
              h.onDeleteEmpty(note.id);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              h.onArrow(note.id, -1);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              h.onArrow(note.id, 1);
            }
          }}
        />
      </div>
      {hasChildren && !note.collapsed && (
        <div className="children">
          {note.children.map(child => (
            <NoteNode key={child.id} note={child} handlers={handlers} />
          ))}
        </div>
      )}
    </div>
  );
}
