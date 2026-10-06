/* model.js: what one heavy click costs a browser's main thread.
 *
 * THIS IS THE LESSON. A small discrete-event simulation of the HTML event
 * loop: a task queue, a microtask checkpoint, a rendering opportunity at every
 * vsync, and — when a worker is used — a second thread that runs in parallel
 * and talks back through postMessage. Every number on the panel comes out of
 * simulate() below; nothing is a table of pre-baked results.
 *
 * The scenario: an animation is running (a JS-driven spinner that needs one
 * frame every 16.7 ms), and the user clicks a button that has to process an
 * image. The same job is run one of three ways:
 *
 *   'main'     one long task on the main thread
 *   'chunked'  the same work split into small tasks that yield between them
 *   'worker'   the pixels are posted to a Web Worker (or two) and back
 *
 * The honest boundary, restated in the About modal and the README:
 *
 *   Genuinely computed  the whole timeline — task order, the microtask
 *                       checkpoint, which vsyncs get a frame and which are
 *                       dropped, chunk interleaving, worker parallelism,
 *                       clone vs transfer, input delay, time to result.
 *   Assumed             every per-operation cost below marked ASSUMED. Real
 *                       numbers depend on the device by a factor of 5-10.
 *   Simplified          one compositor-free main thread; no GC pauses; no
 *                       idle callbacks; a rendering opportunity at every
 *                       vsync (real browsers may skip some when throttled).
 */
(function (global) {
  'use strict';

  var FRAME_MS = 1000 / 60;      // 60 Hz display: one vsync every 16.67 ms
  var CLICK_PHASE = 1.0;         // ASSUMED: the click lands 1 ms after a vsync,
                                 // while that frame is still being rendered
  var HANDLER_MS = 1.2;          // ASSUMED: the click listener itself
  var MICROTASK_MS = 0.4;        // ASSUMED: promise reactions it queued
  var YIELD_MS = 0.08;           // ASSUMED: cost of re-queuing one chunk task
  var CLONE_MS_PER_MB = 2.4;     // ASSUMED: structured clone, each side, per MB
  var TRANSFER_MS = 0.03;        // ASSUMED: handing over an ArrayBuffer (no copy)
  var SPAWN_MS = 28;             // ASSUMED: start a worker + parse its script
  var SPLIT_OVERHEAD = 0.06;     // ASSUMED: each worker's share costs 6% extra
                                 // (edges of the image overlap, cache misses)

  /* The frame that keeps the spinner alive: rAF callback, style, layout and
     paint for a page where only the spinner changed. ASSUMED, but typical of a
     small page on a laptop. */
  var BASE_FRAME = { raf: 0.5, style: 0.3, layout: 0.4, paint: 0.9 };

  /* The frame that shows the result. Costs grow with the number of DOM nodes
     the result touches. ASSUMED per-node costs. */
  function resultFrame(nodes) {
    return {
      dom: 0.6 + nodes * 0.004,       // the onmessage/after-work DOM writes
      style: 0.4 + nodes * 0.0025,    // recalc style for the dirty subtree
      layout: 0.5 + nodes * 0.0035,   // reflow
      paint: 1.1 + nodes * 0.0012,    // paint + commit to the compositor
      composite: 0.9                  // compositor thread: layers -> pixels
    };
  }

  function cloneMs(kb, transfer) {
    return transfer ? TRANSFER_MS : kb / 1024 * CLONE_MS_PER_MB;
  }

  /* p = {mode, workMs, chunkMs, workers, dataKB, transfer, nodes, workerWarm}
   * Returns the main-thread timeline, the worker timelines, the frames, the
   * station-by-station charges and the derived metrics. */
  function simulate(p) {
    var F = FRAME_MS;
    var base = BASE_FRAME.raf + BASE_FRAME.style + BASE_FRAME.layout + BASE_FRAME.paint;
    var rf = resultFrame(p.nodes);

    var main = [];         // {t0, t1, kind, label}
    var workers = [];      // one array of segments per worker
    var rendered = {};     // vsync index -> render start time
    var t = 0;
    var nextVsync = 0;     // index of the next vsync not yet rendered for
    var mark = {};         // milestones, for the station charges

    /* `cont` marks a segment that is the same task as the one before it (the
       microtasks after a handler, the DOM writes after the job). Everything
       else starts a new task, and between tasks the loop may render or handle
       input. */
    function seg(kind, ms, label, cont) {
      if (ms <= 0) return;
      main.push({ t0: t, t1: t + ms, kind: kind, label: label, cont: !!cont });
      t += ms;
    }

    /* A rendering opportunity: if a vsync has passed since the last frame,
       render now (once — any vsyncs skipped meanwhile are lost frames). This
       is the "update the rendering" step that follows every task. */
    function maybeRender() {
      var k = Math.floor(t / F + 1e-9);
      if (k >= nextVsync) {
        rendered[k] = t;
        seg('render', base, 'frame ' + k);
        nextVsync = k + 1;
        return true;
      }
      return false;
    }

    /* Run idle until the next vsync and render there. */
    function idleToVsync() {
      var at = nextVsync * F;
      if (at > t) { main.push({ t0: t, t1: at, kind: 'idle' }); t = at; }
      maybeRender();
    }

    /* Frame 0 is being rendered when the click lands. */
    maybeRender();
    var click = CLICK_PHASE;
    mark.click = click;
    /* the click waits for the task in progress (frame 0's render) to finish */
    if (t < click) { main.push({ t0: t, t1: click, kind: 'idle' }); t = click; }
    mark.handlerStart = t;
    seg('task', HANDLER_MS, 'click handler');
    seg('micro', MICROTASK_MS, 'microtasks', true);
    mark.handlerEnd = t;

    var workEnd, chunks = 0, posted = 0;

    if (p.mode === 'main') {
      /* One task: the whole job, then the DOM writes, before anything else
         can run. Every vsync it spans is a frame the spinner never gets. */
      seg('job', p.workMs, 'processImage()');
      workEnd = t;
      seg('dom', rf.dom, 'write result to DOM', true);
    } else if (p.mode === 'chunked') {
      /* The same work in slices. After each slice the loop gets control back,
         so it can render whenever a vsync has passed. */
      var left = p.workMs;
      while (left > 1e-6) {
        var slice = Math.min(p.chunkMs, left);
        seg('job', slice + YIELD_MS, 'chunk ' + (chunks + 1));
        left -= slice;
        chunks++;
        if (left > 1e-6) maybeRender();
      }
      workEnd = t;
      seg('dom', rf.dom, 'write result to DOM', true);
    } else {
      /* postMessage: the main thread serialises (or transfers) each worker's
         share, and is free the moment that is done. */
      var W = Math.max(1, p.workers | 0);
      var shareKB = p.dataKB / W;
      var arrivals = [];
      for (var w = 0; w < W; w++) {
        seg('clone', cloneMs(shareKB, p.transfer), 'postMessage → worker ' + (w + 1));
        arrivals.push(t);
        posted++;
      }
      mark.postEnd = t;

      /* Each worker runs on its own thread, in parallel with the main thread
         and with each other. */
      var replies = [];
      var crit = null;       /* the worker whose reply arrives last sets the pace */
      for (w = 0; w < W; w++) {
        var ws = [], wt = arrivals[w];
        var push = function (kind, ms, label) {
          if (ms <= 0) return;
          ws.push({ t0: wt, t1: wt + ms, kind: kind, label: label });
          wt += ms;
        };
        /* A message posted before the worker has loaded waits in its inbox. */
        if (!p.workerWarm) push('spawn', SPAWN_MS, 'start worker');
        var e = { spawnEnd: wt };
        push('clone', cloneMs(shareKB, p.transfer), 'deserialise');
        e.unpackEnd = wt;
        push('job', p.workMs / W * (W > 1 ? 1 + SPLIT_OVERHEAD : 1), 'processImage()');
        e.jobEnd = wt;
        push('clone', cloneMs(shareKB, p.transfer), 'postMessage back');
        e.packEnd = wt;
        workers.push(ws);
        replies.push(wt);
        if (!crit || wt >= crit.packEnd) crit = e;
      }
      workEnd = Math.max.apply(null, replies);
      mark.workerDone = workEnd;
      mark.crit = crit;

      /* Meanwhile the main thread just keeps rendering frames. Each reply is
         a task in the queue: it runs at the first gap after it arrives. */
      replies.sort(function (a, b) { return a - b; });
      for (w = 0; w < replies.length; w++) {
        while (t < replies[w]) {
          if (nextVsync * F < replies[w]) idleToVsync();
          else { main.push({ t0: t, t1: replies[w], kind: 'idle' }); t = replies[w]; }
        }
        seg('clone', cloneMs(shareKB, p.transfer), 'onmessage ← worker ' + (replies.length > 1 ? w + 1 : ''));
        if (w < replies.length - 1) maybeRender();
      }
      mark.replyEnd = t;
      seg('dom', rf.dom, 'write result to DOM', true);
    }
    mark.domEnd = t;

    /* The frame that finally shows the result: at once if a vsync has already
       passed, otherwise at the next one. Style, layout and paint run on the
       main thread; compositing happens on the compositor thread after. */
    var at = Math.max(t, nextVsync * F);
    if (at > t) { main.push({ t0: t, t1: at, kind: 'idle' }); t = at; }
    var k = Math.floor(t / F + 1e-9);
    rendered[k] = t;
    nextVsync = k + 1;
    var frameStart = t;
    seg('render', rf.style, 'style (result)');
    mark.styleEnd = t;
    seg('render', rf.layout, 'layout (result)', true);
    mark.layoutEnd = t;
    seg('render', rf.paint, 'paint (result)', true);
    var done = t + rf.composite;
    mark.done = done;

    /* Keep the loop running a little past the result so the strip on the
       panel shows the page recovering. */
    var tailEnd = done + 3 * F;
    while (nextVsync * F < tailEnd) idleToVsync();

    /* ---- frames --------------------------------------------------------- */

    var frames = [];
    var lastK = Math.floor(done / F);
    var dropped = 0, gap = 0, prev = null;
    for (var v = 0; v <= Math.floor(tailEnd / F); v++) {
      var painted = rendered[v] != null;
      frames.push({ k: v, t: v * F, painted: painted, at: rendered[v] });
      if (v <= lastK) {
        if (!painted) dropped++;
        if (painted) { if (prev != null) gap = Math.max(gap, rendered[v] - prev); prev = rendered[v]; }
      }
    }

    /* ---- derived -------------------------------------------------------- */

    var longest = 0, busy = 0;
    main.forEach(function (s) {
      if (s.kind === 'idle') return;
      busy += s.t1 - s.t0;
    });
    /* Longest task: a segment plus its continuations. Rendering is not a
       task; it is the step the loop takes between tasks. */
    var run = 0;
    main.forEach(function (s) {
      if (s.kind === 'idle' || s.kind === 'render') { run = 0; return; }
      run = s.cont ? run + (s.t1 - s.t0) : s.t1 - s.t0;
      if (run > longest) longest = run;
    });

    /* A second tap lands 50 ms into the work. How long until a listener can
       run? It waits for whatever task is running to end. */
    var probe = mark.handlerEnd + 50;
    var inputDelay = 0;
    for (var i = 0; i < main.length; i++) {
      var s = main[i];
      if (s.t0 <= probe && probe < s.t1 && s.kind !== 'idle') {
        /* the tap waits for the end of the whole task, continuations too */
        var end = s.t1;
        for (var j = i + 1; j < main.length && main[j].cont; j++) end = main[j].t1;
        inputDelay = end - probe;
        break;
      }
    }

    /* Station charges: each is the time from the previous milestone to its
       own, so they add up exactly to the time the result reached the screen. */
    var charges = {
      arrive: mark.handlerStart - mark.click,
      loop: mark.handlerEnd - mark.handlerStart,
      stack: 0, post: 0, inbox: 0, unpack: 0, work: 0, pack: 0, reply: 0,
      dom: 0,
      style: mark.styleEnd - mark.domEnd,
      layout: mark.layoutEnd - mark.styleEnd,
      composite: done - mark.layoutEnd
    };
    if (p.mode === 'worker') {
      charges.post = mark.postEnd - mark.handlerEnd;
      /* The worker's own steps, on the slowest worker's clock. Clamped so a
         step that began while the main thread was still posting is charged
         only for the part after it; they still add up to workerDone - postEnd. */
      var m1 = Math.max(mark.postEnd, mark.crit.spawnEnd);
      var m2 = Math.max(m1, mark.crit.unpackEnd);
      var m3 = Math.max(m2, mark.crit.jobEnd);
      charges.inbox = m1 - mark.postEnd;
      charges.unpack = m2 - m1;
      charges.work = m3 - m2;
      charges.pack = mark.workerDone - m3;
      charges.reply = mark.replyEnd - mark.workerDone;
      charges.dom = mark.domEnd - mark.replyEnd;
    } else {
      charges.stack = workEnd - mark.handlerEnd;
      charges.dom = mark.domEnd - workEnd;
    }

    var span = done - mark.handlerEnd;
    return {
      mode: p.mode,
      main: main,
      workers: workers,
      frames: frames,
      charges: charges,
      done: done,
      latency: done - click,
      click: click,
      tailEnd: tailEnd,
      frameStart: frameStart,
      expected: lastK + 1,
      dropped: dropped,
      worstGap: gap,
      longestTask: longest,
      mainBusy: busy,
      inputDelay: inputDelay,
      probeAt: probe,
      chunks: chunks,
      posted: posted,
      cloneEach: p.mode === 'worker' ? cloneMs(p.dataKB / Math.max(1, p.workers), p.transfer) : 0,
      spanFps: span > 0 ? countPainted(frames, mark.handlerEnd, done) / (span / 1000) : 60,
      resultFrame: rf
    };
  }

  /* The longest main-thread task that overlaps [a, b]: how long the page
     could not respond at any one moment during that window. */
  function longestIn(plan, a, b) {
    var best = 0, run = 0, runStart = 0;
    for (var i = 0; i < plan.main.length; i++) {
      var s = plan.main[i];
      if (s.kind === 'idle' || s.kind === 'render') { run = 0; continue; }
      if (!s.cont) { run = 0; runStart = s.t0; }
      run += s.t1 - s.t0;
      if (s.t1 > a + 1e-6 && runStart < b - 1e-6 && run > best) {
        /* include the rest of this task even past b */
        var r = run;
        for (var j = i + 1; j < plan.main.length && plan.main[j].cont && plan.main[j].kind !== 'render'; j++) r += plan.main[j].t1 - plan.main[j].t0;
        if (r > best) best = r;
      }
    }
    return best;
  }

  /* Which threads are busy at time tau. */
  function busyAt(plan, tau) {
    var out = { main: null, workers: [] };
    for (var i = 0; i < plan.main.length; i++) {
      var s = plan.main[i];
      if (s.t0 <= tau && tau < s.t1) { out.main = s.kind === 'idle' ? null : s; break; }
    }
    plan.workers.forEach(function (ws) {
      var hit = null;
      ws.forEach(function (s) { if (s.t0 <= tau && tau < s.t1) hit = s; });
      out.workers.push(hit);
    });
    return out;
  }

  function countPainted(frames, a, b) {
    var n = 0;
    frames.forEach(function (f) { if (f.painted && f.at >= a && f.at <= b) n++; });
    return n;
  }

  /* Was the spinner alive at time tau? Healthy if a frame was painted within
     the last two vsyncs. Drives the spinner on the Compositor Tower. */
  function healthyAt(plan, tau) {
    var last = -1e9;
    for (var i = 0; i < plan.frames.length; i++) {
      var f = plan.frames[i];
      if (f.painted && f.at <= tau) last = f.at;
      if (f.t > tau) break;
    }
    return tau - last <= 2 * FRAME_MS + 0.5;
  }

  function paintedBy(plan, tau) {
    var n = 0, d = 0;
    for (var i = 0; i < plan.frames.length; i++) {
      var f = plan.frames[i];
      if (f.t > tau) break;
      if (f.painted && f.at <= tau) n++;
      else if (f.t + FRAME_MS <= tau && !f.painted) d++;
    }
    return { painted: n, dropped: d };
  }

  function fmtMs(ms) {
    if (ms >= 1000) return (ms / 1000).toFixed(2) + ' s';
    if (ms >= 100) return Math.round(ms) + ' ms';
    if (ms >= 10) return ms.toFixed(1) + ' ms';
    return (Math.round(ms * 100) / 100) + ' ms';
  }

  function fmtKB(kb) {
    if (kb >= 1024) return (kb / 1024).toFixed(1) + ' MB';
    return Math.round(kb) + ' KB';
  }

  global.Model = {
    FRAME_MS: FRAME_MS,
    CLONE_MS_PER_MB: CLONE_MS_PER_MB,
    SPAWN_MS: SPAWN_MS,
    IDLE_FRAME_MS: BASE_FRAME.raf + BASE_FRAME.style + BASE_FRAME.layout + BASE_FRAME.paint,
    simulate: simulate,
    healthyAt: healthyAt,
    longestIn: longestIn,
    busyAt: busyAt,
    paintedBy: paintedBy,
    cloneMs: cloneMs,
    fmtMs: fmtMs,
    fmtKB: fmtKB
  };
})(typeof window !== 'undefined' ? window : globalThis);
