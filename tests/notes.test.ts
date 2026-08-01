import { describe, expect, it } from 'vitest';
import {
  countNotes,
  createNote,
  findNode,
  findPath,
  flattenVisible,
  indentNode,
  insertChild,
  insertSiblingAfter,
  outdentNode,
  removeNode,
  toMarkdown,
  updateNode,
} from '../lib/notes';
import type { Note } from '../types';

const tree = (): Note => ({
  id: 'root',
  text: 'Home',
  children: [
    {
      id: 'a',
      text: 'Alpha',
      children: [
        { id: 'a1', text: 'Alpha one', children: [] },
        { id: 'a2', text: 'Alpha two', children: [] },
      ],
    },
    { id: 'b', text: 'Beta', children: [] },
    {
      id: 'c',
      text: 'Gamma',
      children: [{ id: 'c1', text: 'Gamma one', children: [] }],
      collapsed: true,
    },
  ],
});

describe('findNode / findPath', () => {
  it('finds a nested path from the root', () => {
    expect(findPath(tree(), 'a2')?.map(n => n.id)).toEqual(['root', 'a', 'a2']);
  });

  it('returns null for unknown ids', () => {
    expect(findPath(tree(), 'nope')).toBeNull();
    expect(findNode(tree(), 'nope')).toBeNull();
  });
});

describe('updateNode', () => {
  it('replaces text immutably and keeps untouched branches by identity', () => {
    const before = tree();
    const after = updateNode(before, 'a1', { text: 'changed' });
    expect(findNode(after, 'a1')?.text).toBe('changed');
    expect(findNode(before, 'a1')?.text).toBe('Alpha one');
    expect(after).not.toBe(before);
    expect(findNode(after, 'b')).toBe(findNode(before, 'b'));
  });
});

describe('insert / remove', () => {
  it('inserts a sibling after the target', () => {
    const note = createNote('new');
    const after = insertSiblingAfter(tree(), 'a1', note);
    expect(findNode(after, 'a')?.children.map(c => c.id)).toEqual(['a1', note.id, 'a2']);
  });

  it('inserts a child at an index and expands the parent', () => {
    const note = createNote('new');
    const after = insertChild(tree(), 'c', note, 0);
    const parent = findNode(after, 'c');
    expect(parent?.children[0].id).toBe(note.id);
    expect(parent?.collapsed).toBe(false);
  });

  it('removes a node together with its subtree', () => {
    const after = removeNode(tree(), 'a');
    expect(findNode(after, 'a')).toBeNull();
    expect(findNode(after, 'a1')).toBeNull();
    expect(countNotes(after)).toBe(3);
  });
});

describe('indent / outdent', () => {
  it('indents a note under its previous sibling', () => {
    const after = indentNode(tree(), 'a2');
    expect(findNode(after, 'a1')?.children.map(c => c.id)).toEqual(['a2']);
  });

  it('does not indent a first child', () => {
    const before = tree();
    expect(indentNode(before, 'a1')).toBe(before);
  });

  it('outdents a note and gives it its trailing siblings as children', () => {
    const after = outdentNode(tree(), 'a1');
    expect(after.children.map(c => c.id)).toEqual(['a', 'a1', 'b', 'c']);
    expect(findNode(after, 'a1')?.children.map(c => c.id)).toEqual(['a2']);
    expect(findNode(after, 'a')?.children).toEqual([]);
  });

  it('round-trips indent then outdent', () => {
    const indented = indentNode(tree(), 'a2');
    const back = outdentNode(indented, 'a2');
    expect(findNode(back, 'a')?.children.map(c => c.id)).toEqual(['a1', 'a2']);
  });
});

describe('flattenVisible', () => {
  it('lists notes in document order, skipping collapsed branches', () => {
    expect(flattenVisible(tree()).map(n => n.id)).toEqual(['a', 'a1', 'a2', 'b', 'c']);
  });
});

describe('toMarkdown', () => {
  it('renders the branch as a nested Markdown outline, including collapsed branches', () => {
    expect(toMarkdown(tree())).toBe(
      [
        '# Home',
        '',
        '- Alpha',
        '  - Alpha one',
        '  - Alpha two',
        '- Beta',
        '- Gamma',
        '  - Gamma one',
      ].join('\n')
    );
  });
});
