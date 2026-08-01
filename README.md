<div align="center">

# 🌀 Fractal Notes Distill

**An infinitely zoomable outliner that distills any branch of your notes into its essence.**

*Every bullet is a page. Zoom into any branch, press ✨ Distill, and get the key points — with Gemini when an API key is configured, fully offline when it isn't.*

</div>

## Features

- **Fractal outlining** — every note can contain notes. Click a bullet's dot to zoom in and treat that branch as its own page, with breadcrumbs to zoom back out.
- **Fast keyboard editing** — `Enter` adds a note, `Tab`/`Shift+Tab` indent and outdent, `Backspace` on an empty note deletes it, `↑`/`↓` move between notes.
- **Distill ✨** — reduce the branch you're zoomed into to a short summary:
  - with a `GEMINI_API_KEY` configured, Gemini (`gemini-2.5-flash`) writes the essence, key points, and open loops;
  - without a key — or if the request fails — a built-in offline extractive summarizer takes over, so the button always works.
- **Own your data** — notes live in your browser's localStorage. Copy or export any branch as Markdown at any time.
- **Zero-install fallback** — [`standalone.html`](standalone.html) is a single-file version of the app that runs straight from disk.

## Ways to open the app

### 1. Dev server (recommended)

Prerequisite: Node.js 18+.

```bash
npm install
npm run dev        # → http://localhost:3000
```

### 2. Production build

```bash
npm run build      # type-checks, then bundles to dist/
npm run preview    # serves the built app → http://localhost:4173
```

`dist/` is fully static — deploy it to any static host (GitHub Pages, Netlify, Cloudflare Pages, …).

### 3. No-install standalone file

Open **`standalone.html`** directly in any modern browser — double-click it, no Node, no build step, no network. It is the same outliner with the offline distiller; only Gemini-powered distillation needs the full app.

### 4. Google AI Studio

This repo began life as an AI Studio app. To iterate on it with Gemini in the browser, import it at [aistudio.google.com/apps](https://aistudio.google.com/apps).

## Configuring Gemini (optional)

1. Copy `.env.local.example` to `.env.local`.
2. Set `GEMINI_API_KEY` to a key from [AI Studio](https://aistudio.google.com/apikey).
3. Restart the dev server (or rebuild).

No key? Everything still works — Distill runs the offline summarizer and labels the result "Offline".

## Keyboard reference

| Keys | Action |
| --- | --- |
| `Enter` | New note (first child if the note has expanded children, otherwise next sibling) |
| `Tab` / `Shift+Tab` | Indent / outdent (trailing siblings follow an outdented note) |
| `Backspace` on an empty note | Delete it |
| `↑` / `↓` | Move between notes |
| Click a bullet's **dot** | Zoom into that branch |
| Click the chevron | Collapse / expand a branch |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on port 3000 |
| `npm run build` | `tsc --noEmit` type-check, then production bundle |
| `npm run preview` | Serve the production build |
| `npm test` | Vitest unit tests (tree operations + offline distiller) |

## Project structure

```
index.html             Vite entry
index.tsx              React bootstrap
App.tsx                State, keyboard handling, layout
components/            NoteTree, Breadcrumbs, DistillPanel
lib/notes.ts           Immutable tree operations + Markdown export
lib/clipboard.ts       Clipboard helper with fallback
services/distiller.ts  Gemini + offline distillation
tests/                 Vitest unit tests
standalone.html        Single-file, no-build version of the app
metadata.json          AI Studio app metadata
```

## How distillation works

The current zoomed branch is exported as a Markdown outline. With an API key, that outline is sent to Gemini with a prompt asking for the essence, key points, and open loops. Without one, an extractive summarizer scores every note by how strongly it carries the branch's recurring vocabulary (term frequency, damped by depth and note length) and keeps the top lines in document order — deterministic, dependency-free, and entirely in your browser.

## Roadmap

- Undo/redo history
- Drag-and-drop reordering and a context menu for deleting non-empty branches
- Import Markdown / OPML
