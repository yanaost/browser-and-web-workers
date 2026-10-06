/* ui.js: DOM panels, controls, narration.
 *
 * The canvas shows the mechanism; this file shows the numbers. Every widget
 * here reads Sim.state or calls Model directly. Nothing is stored twice, so
 * the panel can never disagree with the map.
 */
(function (global) {
  'use strict';

  var Sim = global.Sim, World = global.World, Model = global.Model, Iso = global.Iso;

  var $ = function (id) { return document.getElementById(id); };

  var el = {};
  var activeDistrict = null;
  var pinnedDistrict = null;      // set when the reader clicks a district
  var lastPaint = 0;
  var flyTo = null;
  var sheetOpen = false;          // mobile bottom sheet

  var STATION_LABEL = {
    arrive: 'task queued', loop: 'event loop', stack: 'call stack', post: 'postMessage',
    inbox: 'worker inbox', unpack: 'deserialise', work: 'worker', pack: 'postMessage back', reply: 'onmessage', dom: 'DOM', style: 'style', layout: 'layout',
    composite: 'paint', done: 'done'
  };

  var MODE_NAME = { main: 'Main thread', chunked: 'Chunked', worker: 'Web Worker' };

  /* The rows of the waterfall, in the order the cart pays for them. */
  var PHASES = [
    { id: 'arrive', label: 'Wait in queue', note: 'The click waits for the task in progress to finish.' },
    { id: 'loop', label: 'Handler + microtasks', note: 'The click listener, then every resolved promise.' },
    { id: 'stack', label: 'Job on main thread', note: 'The image work, including any frames rendered between chunks.' },
    { id: 'post', label: 'postMessage out', note: 'Structured clone (or transfer) of the pixels, on the main thread.' },
    { id: 'inbox', label: 'Worker inbox', note: 'Waiting for the worker to start (first job only). Main thread free.' },
    { id: 'unpack', label: 'Worker unpacks', note: 'The worker rebuilds the pixels in its own heap.' },
    { id: 'work', label: 'Job on worker', note: 'The same job, on the worker thread. Main thread free.' },
    { id: 'pack', label: 'Worker packs reply', note: 'The worker serialises the result to post it back.' },
    { id: 'reply', label: 'onmessage back', note: 'Waiting for a gap between frames, then deserialising the result.' },
    { id: 'dom', label: 'Write to DOM', note: 'Only the main thread can do this.' },
    { id: 'style', label: 'Wait for vsync + style', note: 'Rendering starts at the next frame; style recalc first.' },
    { id: 'layout', label: 'Layout', note: 'Every dirty box gets a size and position.' },
    { id: 'composite', label: 'Paint + composite', note: 'Drawing commands, then the compositor puts the frame on screen.' }
  ];

  var SEG_COLOR = {
    task: '#d9876a', micro: '#e8b34a', job: '#d07a5e', dom: '#5d9e6c', clone: '#9a7fd0',
    render: '#8cc0dc', spawn: '#c9c0b2'
  };

  /* ------------------------------------------------------------------ init */

  function init() {
    [
      'stage-chip', 'stage-tag', 'stage-name', 'stage-short', 'stage-body',
      'dwell', 'dwell-bar', 'dwell-hint',
      'tl', 'tl-hint', 'tl-legend',
      'wf-list', 'wf-hint', 'sum-done', 'sum-dropped', 'sum-long', 'sum-tap',
      'sum-note', 'cmp', 'district-chips',
      'hud-phase', 'hud-trip', 'hud-elapsed', 'hud-state', 'hud-note',
      'inspector', 'btn-run', 'btn-play', 'play-glyph', 'btn-step', 'btn-reset',
      'speed', 'work', 'chunk', 'data', 'nodes', 'mode',
      'v-speed', 'v-work', 'v-chunk', 'v-data', 'v-nodes',
      'h-chunk', 'workers2', 'transfer', 'follow', 'labels',
      'btn-about', 'about', 'about-close', 'btn-panel', 'tooltip',
      'sheet-handle', 'btn-tune', 'dock', 'dock-tune'
    ].forEach(function (id) { el[id] = $(id); });

    buildChips();
    buildLegend();
    wire();
    applyResponsiveLabels();

    Sim.on(function (name, payload) {
      if (name === 'station') onStation(payload);
      if (name === 'reset') { pinnedDistrict = null; writeIntro(); paint(true); }
      if (name === 'trip-start') paint(true);
    });
  }

  function buildChips() {
    World.districts.forEach(function (d) {
      var b = document.createElement('button');
      b.textContent = d.name;
      b.dataset.id = d.id;
      b.addEventListener('click', function () {
        showDistrict(d, true);
        flyTo = { x: d.x, y: d.y };
      });
      el['district-chips'].appendChild(b);
    });
  }

  function buildLegend() {
    var items = [['job', 'your JS'], ['clone', 'clone / message'], ['dom', 'DOM'],
                 ['render', 'frame'], ['spawn', 'worker start']];
    el['tl-legend'].innerHTML = items.map(function (it) {
      return '<span><i style="background:' + SEG_COLOR[it[0]] + '"></i>' + it[1] + '</span>';
    }).join('') + '<span><i class="dot ok"></i>painted</span><span><i class="dot bad"></i>dropped</span>';
  }

  function wire() {
    el['btn-run'].addEventListener('click', function () { Sim.run(); paint(true); });
    el['btn-play'].addEventListener('click', function () { Sim.toggle(); paint(true); });
    el['btn-step'].addEventListener('click', function () { Sim.step(); });
    /* Run keeps what you have already read; Reset starts the slow tour over. */
    el['btn-reset'].addEventListener('click', function () { Sim.replayTour(); Sim.run(); paint(true); });

    bindRange('speed', 'v-speed', function (v) { Sim.state.speed = v; return v.toFixed(2) + '×'; });
    bindRange('work', 'v-work', function (v) { Sim.state.workMs = v; chunkHint(); return v + ' ms'; });
    bindRange('chunk', 'v-chunk', function (v) { Sim.state.chunkMs = v; chunkHint(); return v + ' ms'; });
    /* the image slider is logarithmic: 256 KB to 32 MB */
    bindRange('data', 'v-data', function (v) {
      var kb = Math.round(256 * Math.pow(2, v));
      Sim.state.dataKB = kb;
      return Model.fmtKB(kb);
    });
    bindRange('nodes', 'v-nodes', function (v) { Sim.state.nodes = v | 0; return (v | 0) + ''; });

    el.mode.addEventListener('change', function () {
      Sim.state.mode = el.mode.value;
      Sim.run();
      paint(true);
    });
    el.workers2.addEventListener('change', function () { Sim.state.workers = el.workers2.checked ? 2 : 1; paint(true); });
    el.transfer.addEventListener('change', function () { Sim.state.transfer = el.transfer.checked; paint(true); });
    el.labels.addEventListener('change', function () { global.Renderer.setLabels(el.labels.checked); });

    el['btn-about'].addEventListener('click', function () { el.about.hidden = false; });
    el['about-close'].addEventListener('click', function () { el.about.hidden = true; });
    el.about.addEventListener('click', function (e) { if (e.target === el.about) el.about.hidden = true; });

    el['btn-panel'].addEventListener('click', function () {
      var hidden = el.inspector.classList.toggle('hidden');
      el['btn-panel'].setAttribute('aria-expanded', String(!hidden));
      applyResponsiveLabels();
    });
    window.addEventListener('resize', function () { applyResponsiveLabels(); paint(true); });

    el['sheet-handle'].addEventListener('click', function () { setSheet(!sheetOpen); });

    el['btn-tune'].addEventListener('click', function () {
      var open = el.dock.classList.toggle('tune-open');
      el['btn-tune'].setAttribute('aria-expanded', String(open));
      el['btn-tune'].title = open ? 'Hide settings' : 'Show settings';
    });
  }

  function isMobile() { return window.matchMedia('(max-width: 900px)').matches; }

  function applyResponsiveLabels() {
    var hidden = el.inspector.classList.contains('hidden');
    var narrow = isMobile();
    el['btn-panel'].textContent = narrow ? (hidden ? 'Panel' : 'Hide')
                                         : (hidden ? 'Show panel' : 'Hide panel');
    el['btn-about'].textContent = narrow ? 'About' : 'About & accuracy';
    el['dwell-hint'].innerHTML = narrow
      ? 'reading stop: tap <b>❚❚</b> below to hold it here'
      : 'reading stop: press <kbd>Space</kbd> to hold it here';
  }

  function setSheet(open) {
    sheetOpen = open;
    el.inspector.classList.toggle('open', open);
    el['sheet-handle'].setAttribute('aria-expanded', String(open));
    if (open) el.inspector.scrollTop = 0;
  }

  /* How many slices the job becomes, and whether one slice plus an idle
     frame's own work still fits between two vsyncs. */
  function chunkHint() {
    var s = Sim.state, h = el['h-chunk'];
    if (!h) return;
    var n = Math.ceil(s.workMs / s.chunkMs);
    var fits = s.chunkMs + Model.IDLE_FRAME_MS <= Model.FRAME_MS;
    h.textContent = '≈ ' + n + ' slices · ' + (fits ? 'each fits a frame' : 'longer than a frame');
    h.className = 'field-hint' + (fits ? '' : ' bad');
  }

  function bindRange(id, out, fn) {
    var input = el[id];
    var apply = function () { el[out].textContent = fn(parseFloat(input.value)); paint(true); };
    input.addEventListener('input', apply);
    el[out].textContent = fn(parseFloat(input.value));
  }

  /* -------------------------------------------------------------- narration */

  function onStation(station) {
    var id = station === 'done' ? null : Sim.state.topic;
    activeDistrict = id;
    if (!pinnedDistrict && id) {
      var d = World.districtById[id];
      if (d) writeCard(d, station);
    }
    if (station === 'done') writeDone();
    paint(true);
  }

  function setChip(text, color) {
    el['stage-chip'].textContent = text;
    el['stage-chip'].style.color = color;
    el['stage-chip'].style.background = Iso.rgba(color, 0.14);
    el['stage-chip'].style.borderColor = Iso.rgba(color, 0.3);
  }

  function writeCard(d, station) {
    setChip(STATION_LABEL[station] || d.id, d.color);
    el['stage-tag'].textContent = d.tag;
    el['stage-name'].textContent = d.name;
    el['stage-short'].textContent = d.short;
    el['stage-body'].textContent = d.body;
  }

  function writeIntro() {
    var s = Sim.state;
    setChip(MODE_NAME[s.tripMode].toLowerCase(), '#8a7f70');
    el['stage-tag'].textContent = s.mode === 'auto' ? 'trip 1 of 3' : 'same job, twice';
    el['stage-name'].textContent = 'One click, one heavy job';
    el['stage-short'].textContent = 'An animation is running and someone clicks "Process image". Watch the clock on the tower: it only ticks when a frame is drawn.';
    el['stage-body'].textContent = s.mode === 'auto'
      ? 'The cart makes the same trip three times. First the job runs on the main thread, then cut into chunks, then in a Web Worker. Every number on this panel comes from a small simulation of the browser\'s event loop.'
      : 'Fixed mode: the job runs as "' + MODE_NAME[s.tripMode] + '" on both trips. Choose Auto in the dock to compare all three.';
  }

  function writeDone() {
    var s = Sim.state;
    setChip('done', '#6e8a5a');
    var r = s.results;
    var modes = Object.keys(r);
    el['stage-tag'].textContent = modes.length + ' way' + (modes.length > 1 ? 's' : '') + ' compared';
    if (r.main && r.worker) {
      el['stage-name'].textContent = 'The same work, a different thread';
      el['stage-short'].textContent = 'On the main thread the result arrived in ' + Model.fmtMs(r.main.latency) +
        ' but ' + r.main.dropped + ' frames were lost. In a worker it took ' + Model.fmtMs(r.worker.latency) +
        ' and ' + (r.worker.dropped ? r.worker.dropped + ' frames were lost.' : 'not a single frame was lost.');
      el['stage-body'].textContent = 'A worker does not make the arithmetic faster. It moves it somewhere the ' +
        'renderer is not waiting. Chunking keeps frames coming too, but it pays for every frame inside the job. ' +
        'Now try the dock: make the image bigger and watch the clone cost grow, turn on Transfer, ' +
        'or split the job across 2 workers. Then press Run again.';
    } else {
      var m = r[modes[0]];
      el['stage-name'].textContent = MODE_NAME[modes[0]] + ': ' + Model.fmtMs(m.latency);
      el['stage-short'].textContent = m.dropped + ' frames dropped, longest task ' + Model.fmtMs(m.longestTask) + '.';
      el['stage-body'].textContent = 'Switch the mode in the dock back to Auto to see all three side by side.';
    }
  }

  function showDistrict(d, pin) {
    pinnedDistrict = pin ? d.id : null;
    writeCard(d, Sim.state.station);
    if (pin) {
      el['stage-chip'].textContent = 'pinned';
      el['stage-tag'].textContent = d.tag + ' · tap empty ground to resume';
      if (isMobile()) setSheet(true);
    }
    updateChips();
  }

  function updateChips() {
    var kids = el['district-chips'].children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].classList.toggle('on', kids[i].dataset.id === (pinnedDistrict || activeDistrict));
    }
  }

  /* ------------------------------------------------------------------ paint */

  function paint(force) {
    var now = performance.now();
    if (!force && now - lastPaint < 90) return;
    lastPaint = now;

    var s = Sim.state;
    var plan = s.plan || Sim.planNow();

    el['play-glyph'].textContent = s.paused || s.finished ? '▶' : '❚❚';

    el['hud-phase'].textContent = s.station ? (STATION_LABEL[s.station] || s.station) : 'idle';
    el['hud-trip'].textContent = MODE_NAME[s.tripMode] + ' · ' +
      Math.min(s.trip + (s.finished ? 0 : 1), s.maxTrips) + '/' + s.maxTrips;
    el['hud-elapsed'].textContent = Model.fmtMs(s.running ? Math.max(0, Sim.tau() - plan.click) : 0);
    el['hud-state'].textContent = threadState(s, plan);
    el['hud-note'].textContent = hudNote(s);

    var showing = s.reading && s.dwellTotal > 0 && s.dwellLeft > 0;
    el.dwell.hidden = !showing;
    if (showing) el['dwell-bar'].style.width = (s.dwellLeft / s.dwellTotal * 100).toFixed(1) + '%';

    paintTimeline(s, plan);
    paintWaterfall(s, plan);
    paintSummary(s, plan);
    paintCompare(s);
    updateChips();
  }

  function threadState(s, plan) {
    if (!s.running || s.finished) return '—';
    var b = Model.busyAt(plan, Sim.tau());
    var m = b.main;
    var main = !m ? 'free' : m.kind === 'render' ? 'frame' : 'busy';
    var w = b.workers.filter(function (x) { return x; }).length;
    return main + (plan.workers.length ? ' · ' + w + '/' + plan.workers.length + ' workers busy' : '');
  }

  function hudNote(s) {
    if (s.finished) return '';
    if (s.reading) return '⏸ holding here so you can read the panel';
    if (!s.running) return 'Press Run to send a click across the island.';
    if (s.tripMode === 'chunked' && (Sim.van.routeName === 'ringA' || Sim.van.routeName === 'ringB') && s.charged.loop != null)
      return '↻ each lap of the loop is a batch of slices, with frames painted between them';
    if (Sim.van.routeName === 'worker') return '⇢ the job has left the main island; the loop keeps painting';
    if (s.fastForward) return '⏩ same mode again: running it at speed';
    if (s.tourDone) return '⏩ every station explained, running the rest at speed (drag Speed down to slow it)';
    return '';
  }

  /* The thread timeline: what each thread was doing, frame by frame, with a
     cursor at the cart's display time. */
  function paintTimeline(s, plan) {
    var cv = el.tl;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var W = cv.clientWidth || 300;
    var rows = 1 + plan.workers.length;
    var H = 30 + rows * 22 + 8;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.height = H + 'px';
    }
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    var L = 54, R = W - 6, span = plan.tailEnd;
    var X = function (ms) { return L + (R - L) * Math.min(1, ms / span); };
    var tau = s.running ? Sim.tau() : 0;

    g.font = '10px ui-monospace, Menlo, monospace';
    g.textBaseline = 'middle';

    /* frame row: one dot per vsync */
    g.fillStyle = '#7a7266';
    g.fillText('frames', 4, 12);
    plan.frames.forEach(function (f) {
      var x = X(f.t);
      var past = !s.running || f.t <= tau;
      var shown = f.t <= plan.done + Model.FRAME_MS;
      g.strokeStyle = 'rgba(120,110,96,0.18)';
      g.beginPath(); g.moveTo(x, 20); g.lineTo(x, H - 4); g.stroke();
      if (!shown) return;
      g.fillStyle = f.painted ? (past ? '#5fae66' : 'rgba(95,174,102,0.3)')
                              : (past ? '#d9574a' : 'rgba(217,87,74,0.3)');
      g.beginPath(); g.arc(x, 12, f.painted ? 3 : 3.4, 0, 6.2832); g.fill();
    });

    function row(y, segs, name) {
      g.fillStyle = '#7a7266';
      g.fillText(name, 4, y + 8);
      g.fillStyle = 'rgba(120,110,96,0.08)';
      g.fillRect(L, y, R - L, 16);
      segs.forEach(function (sg) {
        if (sg.kind === 'idle') return;
        var x0 = X(sg.t0), x1 = Math.max(x0 + 0.8, X(sg.t1));
        var past = !s.running || sg.t0 <= tau;
        g.fillStyle = SEG_COLOR[sg.kind] || '#aaa';
        g.globalAlpha = past ? 1 : 0.32;
        g.fillRect(x0, y + 1, x1 - x0, 14);
      });
      g.globalAlpha = 1;
    }
    row(26, plan.main, 'main');
    plan.workers.forEach(function (ws, i) { row(26 + (i + 1) * 22, ws, 'worker' + (plan.workers.length > 1 ? ' ' + (i + 1) : '')); });

    /* the result reaching the screen */
    var xd = X(plan.done);
    g.strokeStyle = '#3d3831';
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(xd, 20); g.lineTo(xd, H - 4); g.stroke();
    g.setLineDash([]);

    if (s.running && !s.finished) {
      var xc = X(tau);
      g.strokeStyle = '#b8503f';
      g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(xc, 4); g.lineTo(xc, H - 2); g.stroke();
      g.lineWidth = 1;
    }

    el['tl-hint'].textContent = Model.fmtMs(span) + ' shown · dashed line = result on screen';
  }

  function paintWaterfall(s, plan) {
    var max = 1;
    PHASES.forEach(function (p) { if (plan.charges[p.id] > max) max = plan.charges[p.id]; });
    var paidN = s.charged ? Object.keys(s.charged).length : 0;
    el['wf-hint'].textContent = s.running ? paidN + ' paid · ' + MODE_NAME[s.tripMode] : 'projected';

    el['wf-list'].innerHTML = PHASES.map(function (p) {
      var paid = s.charged && s.charged[p.id] != null;
      var live = s.station === p.id;
      var ms = paid ? s.charged[p.id] : plan.charges[p.id];
      var zero = ms < 0.005;
      return '<div class="bar' + (paid ? ' paid' : '') + (live ? ' live' : '') + (zero ? ' cut' : '') + '"' +
        ' title="' + escapeHtml(p.note) + '">' +
        '<span class="lbl">' + escapeHtml(p.label) + '</span>' +
        '<span class="track"><span class="fill" style="width:' +
        (Math.min(1, ms / max) * 100).toFixed(1) + '%"></span></span>' +
        '<span class="val">' + (zero ? '—' : Model.fmtMs(ms)) + '</span></div>';
    }).join('');
  }

  function paintSummary(s, plan) {
    el['sum-done'].textContent = Model.fmtMs(plan.latency);
    el['sum-dropped'].textContent = plan.dropped + ' / ' + plan.expected;
    el['sum-dropped'].className = plan.dropped ? 'bad' : 'ok';
    el['sum-long'].textContent = Model.fmtMs(plan.longestTask);
    el['sum-long'].className = plan.longestTask > 50 ? 'bad' : '';
    el['sum-tap'].textContent = Model.fmtMs(plan.inputDelay);
    el['sum-tap'].className = plan.inputDelay > 100 ? 'bad' : '';

    /* The one sentence worth taking away, chosen from what actually binds. */
    var note;
    if (plan.mode === 'main') {
      note = 'One ' + Model.fmtMs(plan.longestTask) + ' task: the page cannot paint, scroll or respond for all of it. ' +
        'Anything over 50 ms counts as a long task, and a tap that lands during it waits ' + Model.fmtMs(plan.inputDelay) + '.';
    } else if (plan.mode === 'chunked') {
      var extra = plan.latency - Sim.planFor('main').latency;
      note = plan.chunks + ' slices of ' + Model.fmtMs(s.chunkMs) + '. ' +
        (plan.dropped ? plan.dropped + ' frames still dropped, so make the slices smaller. '
                      : 'Every frame painted, ') +
        'and the result arrives ' + Model.fmtMs(Math.max(0, extra)) + ' later than in one long task: the frames now share the thread with the job.';
    } else {
      var clone = plan.cloneEach * 2 * plan.posted;
      note = 'The main thread spent ' + Model.fmtMs(clone) + ' on ' + (s.transfer ? 'transferring' : 'copying') +
        ' pixels and nothing on the job itself. ' +
        (s.transfer ? 'With a transfer nothing is copied; the page\'s buffer is detached instead.'
                    : 'Structured clone costs about ' + Model.CLONE_MS_PER_MB + ' ms per MB each way; turn on Transfer to skip it.') +
        (plan.workers[0] && plan.workers[0][0].kind === 'spawn'
          ? ' This trip also paid ' + Model.fmtMs(Model.SPAWN_MS) + ' to start the worker; a warm one skips that.' : '');
    }
    el['sum-note'].textContent = note;
  }

  /* All three ways with the current settings, recomputed live. */
  function paintCompare(s) {
    var cur = s.running ? s.tripMode : null;
    var rows = ['main', 'chunked', 'worker'].map(function (m) {
      var p = Sim.planFor(m, m === 'worker' ? false : null);
      return '<tr class="' + (m === cur ? 'on' : '') + '"><th>' + MODE_NAME[m] + '</th>' +
        '<td>' + Model.fmtMs(p.latency) + '</td>' +
        '<td class="' + (p.dropped ? 'bad' : 'ok') + '">' + p.dropped + '</td>' +
        '<td class="' + (p.longestTask > 50 ? 'bad' : '') + '">' + Model.fmtMs(p.longestTask) + '</td></tr>';
    });
    el.cmp.innerHTML = '<thead><tr><th></th><th>result</th><th>dropped</th><th>longest task</th></tr></thead><tbody>' +
      rows.join('') + '</tbody>';
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------------------------------------------------------- exports */

  global.UI = {
    init: init,
    paint: paint,
    run: function () { Sim.run(); paint(true); },
    resetAll: function () { Sim.replayTour(); Sim.run(); paint(true); },
    showDistrict: showDistrict,
    unpin: function () { pinnedDistrict = null; updateChips(); },
    activeDistrict: function () { return pinnedDistrict || activeDistrict; },
    takeFlyTo: function () { var f = flyTo; flyTo = null; return f; },
    el: el
  };
})(window);
