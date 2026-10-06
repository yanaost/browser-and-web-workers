# How a Browser Runs Frontend Work

An isometric explainer showing how browsers execute JavaScript, handle rendering, and coordinate work across the main thread and Web Workers.

## The Map

A vehicle travels through this world, showing how work flows:

### Main Districts

- **Main Thread Boulevard** (central loop) — Where JavaScript code executes, sequentially
- **JavaScript Engine Foundry** — Where the JS engine parses and executes code
- **Event Loop** — The core mechanism that schedules work (tasks, microtasks, rendering)
- **DOM Plaza** — DOM manipulation and element updates
- **Style and Layout Mill** — CSS processing and layout calculations
- **Paint Studio** — Rasterizing elements to pixels
- **Compositor Arch** — Compositing layers and displaying on screen
- **Layer Counter Arch** — Managing paint and composite tasks
- **Network Docks** — Fetching resources (HTTP requests)
- **Message Port Bridge** — Communication channel between main thread and workers
- **Worker District** — Where Web Workers run in parallel (off-main-thread)
  - **Worker Mills** — Individual worker threads executing their own code
  - **Shared Buffer Yard** — SharedArrayBuffer for direct memory sharing

## Project Structure

### browser-internals/
Reference materials on:
- Event loop order (tasks, microtasks, rendering)
- Call stack and execution model
- When repaints and reflows happen

### web-workers/
Reference materials on:
- Dedicated Workers (one-to-one communication)
- Web Worker API basics
- postMessage and message events

### examples/
(To be built as stations)

### docs/
Additional explanations and diagrams

---

Created: 2026-10-06 | Built with [isometric-explainer skill](~/.claude/skills/isometric-explainer)
