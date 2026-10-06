# Browser & Web Workers Deep Dive

A comprehensive learning project exploring how browsers work and how to use Web Workers for multi-threaded JavaScript.

## Structure

### 📚 [browser-internals/](./browser-internals/)
- Event loop, call stack, and task queues
- Rendering pipeline and repaint/reflow
- Memory management and garbage collection
- JavaScript engine internals

### 🔧 [web-workers/](./web-workers/)
- Dedicated Workers
- Shared Workers
- Service Workers
- Worker communication patterns

### 💡 [examples/](./examples/)
- Working code examples for each concept
- Interactive demos
- Performance comparisons

### 📖 [docs/](./docs/)
- Deep explanations and diagrams
- Resource links

## Learning Path

1. **Browser Fundamentals**
   - How the browser parses HTML/CSS/JS
   - Event loop and task execution
   - Rendering and repaint cycles

2. **Concurrency Patterns**
   - Single-threaded JavaScript model
   - Callbacks, Promises, async/await
   - Microtasks vs macrotasks

3. **Web Workers**
   - When and why to use workers
   - Worker lifecycle and communication
   - Different worker types

4. **Advanced Topics**
   - Worker pools and patterns
   - Performance optimization
   - Memory management with workers

## Quick Start

```bash
npm install
npm run dev  # Start dev server for examples
```

## Resources

- [MDN: How browsers work](https://developer.mozilla.org/en-US/docs/Web/Performance/How_browsers_work)
- [MDN: Web Workers API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API)
- [Tabs and Extensions talk](https://www.youtube.com/watch?v=9Cq60pA0i6Q) - Browser architecture

---

Created: 2026-10-06
