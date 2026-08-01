import type { Note } from '../types';

export const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const createNote = (text = '', children: Note[] = []): Note => ({
  id: uid(),
  text,
  children,
});

export function findNode(root: Note, id: string): Note | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export function findPath(root: Note, id: string): Note[] | null {
  if (root.id === id) return [root];
  for (const child of root.children) {
    const path = findPath(child, id);
    if (path) return [root, ...path];
  }
  return null;
}

export function updateNode(
  root: Note,
  id: string,
  patch: Partial<Note> | ((note: Note) => Note)
): Note {
  const apply = typeof patch === 'function' ? patch : (note: Note) => ({ ...note, ...patch });
  if (root.id === id) return apply(root);
  let changed = false;
  const children = root.children.map(child => {
    const next = updateNode(child, id, patch);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

export function removeNode(root: Note, id: string): Note {
  const index = root.children.findIndex(child => child.id === id);
  if (index >= 0) {
    return { ...root, children: root.children.filter(child => child.id !== id) };
  }
  let changed = false;
  const children = root.children.map(child => {
    const next = removeNode(child, id);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

export function insertSiblingAfter(root: Note, targetId: string, note: Note): Note {
  const index = root.children.findIndex(child => child.id === targetId);
  if (index >= 0) {
    const children = [...root.children];
    children.splice(index + 1, 0, note);
    return { ...root, children };
  }
  let changed = false;
  const children = root.children.map(child => {
    const next = insertSiblingAfter(child, targetId, note);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

export function insertChild(root: Note, parentId: string, note: Note, index = 0): Note {
  return updateNode(root, parentId, parent => {
    const children = [...parent.children];
    children.splice(Math.min(index, children.length), 0, note);
    return { ...parent, children, collapsed: false };
  });
}

export function indentNode(root: Note, id: string): Note {
  const index = root.children.findIndex(child => child.id === id);
  if (index > 0) {
    const node = root.children[index];
    const prev = root.children[index - 1];
    const newPrev = { ...prev, collapsed: false, children: [...prev.children, node] };
    const children = [...root.children];
    children.splice(index - 1, 2, newPrev);
    return { ...root, children };
  }
  if (index === 0) return root;
  let changed = false;
  const children = root.children.map(child => {
    const next = indentNode(child, id);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

export function outdentNode(root: Note, id: string): Note {
  for (let pi = 0; pi < root.children.length; pi++) {
    const parent = root.children[pi];
    const ni = parent.children.findIndex(child => child.id === id);
    if (ni >= 0) {
      const node = parent.children[ni];
      // Trailing siblings follow the outdented note as its children,
      // matching the behavior of classic outliners.
      const trailing = parent.children.slice(ni + 1);
      const newParent = { ...parent, children: parent.children.slice(0, ni) };
      const newNode = { ...node, children: [...node.children, ...trailing] };
      const children = [...root.children];
      children.splice(pi, 1, newParent);
      children.splice(pi + 1, 0, newNode);
      return { ...root, children };
    }
  }
  let changed = false;
  const children = root.children.map(child => {
    const next = outdentNode(child, id);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

export function flattenVisible(root: Note): Note[] {
  const out: Note[] = [];
  const walk = (note: Note) => {
    for (const child of note.children) {
      out.push(child);
      if (!child.collapsed) walk(child);
    }
  };
  walk(root);
  return out;
}

export function countNotes(root: Note): number {
  let count = 0;
  const walk = (note: Note) => {
    for (const child of note.children) {
      count++;
      walk(child);
    }
  };
  walk(root);
  return count;
}

export function toMarkdown(root: Note): string {
  const lines: string[] = [];
  const title = root.text.trim();
  if (title) lines.push(`# ${title}`, '');
  const walk = (note: Note, depth: number) => {
    for (const child of note.children) {
      lines.push(`${'  '.repeat(depth)}- ${child.text.trim()}`.trimEnd());
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return lines.join('\n');
}
