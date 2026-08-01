import { describe, expect, it } from 'vitest';
import { distillLocal, tokenize } from '../services/distiller';
import type { Note } from '../types';

const note = (text: string, children: Note[] = []): Note => ({ id: text, text, children });

describe('tokenize', () => {
  it('lowercases, strips punctuation, and drops stopwords', () => {
    expect(tokenize('The Garden—Needs Volunteers!')).toEqual(['garden', 'volunteers']);
  });
});

describe('distillLocal', () => {
  it('explains when there is nothing to distill', () => {
    expect(distillLocal(note('Empty'))).toMatch(/Nothing to distill/);
  });

  it('keeps the most thematic lines and reports counts', () => {
    const root = note('Project', [
      note('Launch the garden website before the June open day.'),
      note('The garden website features a plot map and signup form.'),
      note('Buy more coffee.'),
      note('Volunteers write the garden planting calendar for the website.'),
      note('Ask Priya for harvest photos for the garden website gallery.'),
    ]);
    const out = distillLocal(root);
    expect(out).toContain('**Project**');
    expect(out).toContain('5 notes');
    expect(out).toMatch(/garden/);
    const bullets = out.split('\n').filter(line => line.startsWith('- '));
    expect(bullets.length).toBeGreaterThanOrEqual(3);
    expect(bullets.length).toBeLessThanOrEqual(7);
  });

  it('lists recurring themes', () => {
    const root = note('Trip', [
      note('Book the mountain cabin for the hiking trip.'),
      note('Plan the hiking routes around the cabin.'),
      note('Pack rain gear for the hiking days.'),
    ]);
    expect(distillLocal(root)).toMatch(/Recurring themes:.*hiking/);
  });
});
