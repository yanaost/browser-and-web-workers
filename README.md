# Thread Island

**How a browser runs your JavaScript, and what a Web Worker changes.**

A floating isometric island: the painting `2banR.jpg` with a live layer drawn over it. One heavy
click ("Process image") travels across it three times, and each trip does the same
job a different way:

1. **On the main thread.** The job blocks the event loop for about 480 ms. The
   clock on the tower stops and 28 of 30 frames are dropped.
2. **In chunks.** The job is cut into 8 ms slices with a yield between each one.
   Every frame is painted, but the result arrives later.
3. **In a Web Worker.** The pixels cross the postMessage bridge to a mill on its
   own island. The main thread keeps painting while the worker does the job.

Every number on screen comes from a small discrete-event simulation of the
browser's event loop (`js/model.js`). It runs live in your browser and reruns
whenever you drag a slider.

## Run it

Open `index.html` in a browser. There's no build step, no dependencies and no
network calls, and it works from `file://`. To serve it instead:

```bash
python3 -m http.server 8000   # then open http://localhost:8000/
```

## The journey

The main island is the **main thread**. The two worker mills stand on islands of
their own, because a worker shares no memory with the page. The only way to reach
them is over a bridge, by message.

| Station | Place | What the cart pays for | Model step |
|---|---|---|---|
| arrive | Network Docks | The click waits in the task queue | `arrive` |
| loop | Event Loop (clock tower plaza) | The click handler, then the microtask queue | `loop` |
| stack | Call Stack Yard | The job on the main thread. In chunked mode it's 3 laps of the ring, with frames painted between slices | `stack` |
| post | postMessage Bridge | Structured clone of the pixels, or a transfer | `post` |
| inbox | Worker Inbox | The message waits in the worker's own queue while the worker starts (first trip only, 28 ms; 0 when warm) | `inbox` |
| unpack | Unpacking Bench | The worker deserialises the pixels into its own heap (or takes ownership, with Transfer) | `unpack` |
| work | Web Worker Mill | The job itself, on the worker thread | `work` |
| pack | Packing Dock | The worker serialises the reply with postMessage: it has no DOM to write to | `pack` |
| reply | postMessage Bridge | Waiting for a free moment between frames, then deserialising | `reply` |
| dom | DOM Garden | Writing the result into the DOM (main thread only) | `dom` |
| style | CSS Foundry | Waiting for the next vsync, then style recalc | `style` |
| layout | Layout Workshop | Layout of the dirty nodes | `layout` |
| composite | Compositor Tower | Paint and composite: the result is on screen | `composite` |

In a worker trip the cart skips the Call Stack Yard. In main-thread and chunked
trips it skips the bridge. The station charges add up exactly to the
click-to-pixels latency.

**The cart carries state, not cargo:**

- The crates are the image's megabytes.
- The gauge on the cart's flank is the longest main-thread task in the step just
  paid for, measured against the 16.7 ms frame budget.
- The plate above the cart shows the time since the click and whether the main
  thread is busy at that moment.

**The instruments are live readouts:**

- The clock hands on the painted tower move once per painted frame.
- The crates in the Call Stack Yard show the call-stack depth.
- The Yield Signal turns red while a task holds the thread.
- The gears drawn over a mill's painted gears turn, and its chimneys smoke, only while that worker is busy.
- On the worker's island: a worker.js loading bar over the inbox while the worker starts,
  crates stacking on the bench as the pixels are unpacked and at the dock as the reply is
  packed. With 2 workers these follow the worker whose reply arrives last.
- The "no DOM" sign by the dock is a fact, not a readout: a worker has no `document`.
- In clone mode, the copy left behind at the bridgehead stays piled up. In
  transfer mode there's no pile: the buffer is detached.

## Controls

- **Space**: play or pause. **S**: step one station. **R**: reset and replay the
  tour. **F**: follow the cart. **L**: labels.
- Drag to pan and scroll to zoom. Click any place for its write-up. Double-click
  the map (or press ⤢) to fit the whole island.
- In the dock (⚙ on a phone):
  - mode (Auto runs all three, or pick one)
  - speed, the job's CPU time, chunk size, image size and DOM nodes touched
  - **Transfer** instead of copying
  - **2 workers** to split the job across both mills

The panel shows:

- a frame-by-frame timeline of the threads (green dots are painted frames, red
  dots are dropped ones)
- a waterfall of where the time went
- this trip's stats: result on screen, frames dropped, longest task, and how long
  a second tap would wait
- a live table comparing all three modes with your current settings

## Pacing

The first time the cart reaches a place, it stops for as long as that place's
write-up takes to read: `words / 3.8 + 3.5` seconds, between 9 and 26 s. A bar
under the text shows how much of the stop is left, and the panel's timeline
animates through the step during the stop. Later visits get a short beat. Once
every place has been explained, the remaining trips run at a watchable pace. Only
the Speed slider shortens a reading stop.

**Run** keeps what you've already read. **Reset** (⟲) replays the slow tour.

## Fidelity ledger: what to trust

**Computed live.** `model.js` simulates the HTML event loop:

- One task runs to completion at a time.
- Microtasks drain after the handler.
- The loop gets a rendering opportunity after every task. A frame is painted only
  if a vsync has passed and the main thread is free.
- Workers run on their own timelines in parallel. Their replies queue as tasks
  that wait for the main thread.

From that, the model derives:

- which frames are painted or dropped
- how chunks interleave with frames
- the cost of structured clone versus transfer
- worker start-up, and the Promise.all wait with 2 workers
- the longest task, and how long a second tap would wait
- when the result reaches the screen

The waterfall bars are differences between the simulation's milestones, so they
add up exactly.

**Assumed.** Each of these is marked `ASSUMED` in the source:

| Quantity | Value |
|---|---|
| Display | 60 Hz (16.67 ms frames) |
| Click lands after a vsync | 1.0 ms |
| Click handler / microtasks | 1.2 ms / 0.4 ms |
| Structured clone | 2.4 ms per MB, each side |
| Transfer | 0.03 ms |
| Worker start-up (cold) | 28 ms |
| Overhead per half of a split job | 6% |
| Queueing each chunk | 0.08 ms |
| An idle frame (rAF + style + layout + paint) | 2.1 ms |
| Result style / layout / paint | linear in DOM nodes touched |

Real devices differ by 5–10× on every one of these. Trust the shape (what blocks
what, and what grows with what), not the exact milliseconds.

**Simplified:**

- No GC pauses, idle callbacks, task priorities, or background throttling.
- There's a rendering opportunity at every vsync.
- The compositor is a fixed cost after paint.
- In chunked mode, the cart's 3 laps stand for every slice (often 60). Each lap
  is charged a third of the simulated time. The panel timeline shows every real
  slice.

**Scenery:** the island is the painting `2banR.jpg`, drawn as is. The
generator's watermark in the corner is covered with water. The cart's roads are
traced onto the painted paths. Trees, clouds, cubes, docks, the boat and the
painted envelopes and crates are part of the picture and mean nothing. The Call
Stack Yard plate and the small Yield Signal, Inbox, Unpacking Bench and Packing Dock tags
are added (the worker tags are smaller, with a leader to their spot); the no-DOM sign is an added model. Everything drawn live (the
cart, clock hands, gears, smoke, glows, envelope, chips) is a readout of
the model at the cart's moment in time.

## Files

```
index.html       markup, controls, the About modal (the same ledger as above)
css/styles.css   the pastel shell: full-screen canvas, floating panels, phone layout
js/iso.js        engine: projection, solids, routes
js/model.js      THE LESSON: event-loop simulation (simulate, busyAt, longestIn, ...)
js/world.js      the place: roads traced onto the painting, routes, stations, districts and copy
js/sim.js        the state machine: travel, stations, reading stops, the 3-trip tour
js/render.js     the painting as backdrop, occluder cut-outs, live instruments, cart, labels
js/ui.js         panel: narration, thread timeline, waterfall, stats, comparison
js/main.js       engine: camera, input, frame loop
smoke.mjs        headless check: console errors, every station, a screenshot
```

The scripts load in that order as plain ES5 IIFEs. Each one hangs a single global
(`Iso`, `Model`, `World`, `Sim`, `Renderer`, `UI`) on `window`.

## Verify

```bash
for f in js/*.js; do node --check "$f" || echo "FAIL $f"; done
npm i && npx playwright install chromium     # once; Playwright is the only dev dependency
python3 -m http.server 8000 &
node smoke.mjs http://localhost:8000/        # fails on any console error; writes smoke.png
```

Built from the isometric-explainer skill. All code and copy are original.
