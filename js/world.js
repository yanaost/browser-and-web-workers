/* world.js: the static place — islands, routes, stations, districts, props.
 *
 * Nothing here animates and nothing here computes the lesson. This file only
 * answers "where is everything, and what does each place mean".
 *
 * The layout is traced from the concept art (2banR.jpg): a main island that
 * is the main thread, an event-loop plaza with a clock tower at its heart, and
 * two worker mills on islands of their own, reachable only by bridge. That
 * last part is the point: a worker shares no ground with the page. Everything
 * that reaches it crosses a postMessage bridge.
 *
 * Contracts the rest of the code depends on:
 *   routes[name]      a polyline the cart drives, parameterised by distance
 *   stations[name]    distances along that polyline that fire a model step
 *   topicOf(id, s)    which district's write-up a station shows
 */
(function (global) {
  'use strict';

  var Iso = global.Iso;
  var makeRoute = Iso.makeRoute;

  /* ---- art-space helper ------------------------------------------------- */

  /* Positions are measured in pixels on the 1168x784 concept image and mapped
     onto the grid, so the place keeps the art's composition. The art is drawn
     in (nearly) the same 2:1 projection as Iso, so this is just an inverse
     projection with a scale. */
  var K = 1.6, OX = 26, OY = 21;
  function I(px, py) {
    var sx = (px - 520) * K, sy = (py - 300) * K;
    return [(sx / Iso.TW + sy / Iso.TH) / 2 + OX, (sy / Iso.TH - sx / Iso.TW) / 2 + OY];
  }
  function IP(list) { return list.map(function (p) { return I(p[0], p[1]); }); }

  /* The scenery is the painting itself (render.js draws 2banR.jpg as the
     backdrop), so these helpers go both ways: art pixel -> grid, and art
     pixel -> world screen. */
  var ART = {
    w: 1168, h: 784, K: K,
    /* where art pixel (0,0) lands in world-screen space, and the drawn size */
    x0: (0 - 520) * K + (OX - OY) * Iso.TW,
    y0: (0 - 300) * K + (OX + OY) * Iso.TH
  };
  function toScreen(px, py) { return { x: ART.x0 + px * K, y: ART.y0 + py * K }; }

  /* ---- islands (outline only; used to frame the view) ------------------- */

  var ISLANDS = {
    main: IP([[95, 255], [160, 175], [250, 105], [380, 70], [520, 55], [640, 60],
              [760, 100], [805, 170], [800, 260], [792, 420], [770, 500], [700, 560],
              [560, 600], [420, 620], [300, 600], [200, 560], [130, 500], [90, 400]]),
    millA: IP([[865, 270], [930, 222], [1040, 212], [1112, 258], [1118, 340],
               [1062, 402], [960, 418], [880, 386], [850, 322]]),
    millB: IP([[848, 540], [905, 478], [1012, 466], [1098, 518], [1104, 612],
               [1042, 672], [930, 684], [860, 642]])
  };

  /* ---- the event-loop ring --------------------------------------------- */

  /* The painted ring road is an ellipse in art space. Angles are in screen
     sense: 0 is east, 90 is south (down the picture). */
  var RING_ART = { cx: 503.5, cy: 287, a: 112.5, b: 66 };
  var DEG = Math.PI / 180;
  function ringArt(deg) {
    return [RING_ART.cx + RING_ART.a * Math.cos(deg * DEG), RING_ART.cy + RING_ART.b * Math.sin(deg * DEG)];
  }
  function ringPt(deg) { var p = ringArt(deg); return I(p[0], p[1]); }
  function arcArt(from, to, step) {
    var out = [], dir = to < from ? -1 : 1;
    for (var d = from; dir > 0 ? d < to - 1e-6 : d > to + 1e-6; d += step * dir) out.push(ringArt(d));
    out.push(ringArt(to));
    return out;
  }
  var RING_C = I(RING_ART.cx, RING_ART.cy);
  var RING_R = 4.4;
  var GATE_DEG = 155, EAST_DEG = 83;
  var GATE = ringPt(GATE_DEG);   // where the docks road joins the loop
  var EAST = ringPt(EAST_DEG);   // where the centre road leaves it, south

  /* ---- routes ------------------------------------------------------------ */

  /* A route is built from art points; a point tagged with a name records its
     index so the stations below never depend on counting by hand. */
  function build_(list) {
    var pts = [], marks = {};
    list.forEach(function (p) {
      if (typeof p === 'string') { marks[p] = pts.length - 1; return; }
      pts.push(I(p[0], p[1]));
    });
    var r = makeRoute(pts);
    r.marks = marks;
    return r;
  }

  /* From the lower pier, up the stairs, through the arch and up the hill to
     the gate of the loop: a task arriving. */
  var ARRIVE = build_([
    [262, 672], [275, 640], [283, 622], [272, 590], [267, 565], [260, 540],
    [275, 515], [285, 495], [272, 470], [258, 440], [267, 405], [298, 378],
    [343, 358], [372, 338], ringArt(GATE_DEG)
  ]);

  /* The near half of the ring, gate round the bottom to the south exit. */
  var RING_A = build_(arcArt(GATE_DEG, EAST_DEG, 9));

  /* The far half: south exit, up the east side, behind the clock tower and
     down the west side past the Call Stack Yard, back to the gate. */
  var RING_B = build_([].concat(arcArt(EAST_DEG, -173, 8), ['stack'], arcArt(-173, GATE_DEG - 360, 8).slice(1)));

  /* Down the centre road, east along the cliff and over the bridge to
     Worker Mill A, then back on the other lane. A worker lives on its own
     island: nothing the main thread owns is reachable from there. */
  var OUT = [
    [518, 380], [524, 410], [540, 445], [556, 472], [578, 510], [610, 532],
    [650, 540], [690, 528], [718, 512], [737, 490], [748, 470], [756, 450],
    [752, 428], [741, 405], [733, 385], [738, 368], [752, 358], 'post',
    [775, 352], [800, 348], [837, 347], [868, 349]
  ];
  /* Across the mill's plaza, one stop per step the worker takes: the inbox
     by the clerk, the unpacking bench, the gears, the packing dock. */
  var PLAZA = [
    [888, 350], 'inbox', [910, 356], [932, 360], 'unpack', [958, 362],
    [985, 360], 'work', [1012, 361], [1040, 360], 'pack', [1058, 364]
  ];
  var BACK = [];
  for (var i = OUT.length - 1; i >= 0; i--) {
    var p = OUT[i];
    if (typeof p === 'string') continue;
    BACK.push([p[0] - 3, p[1] + 6]);
    if (p[0] === 752 && p[1] === 358) BACK.push('reply');
  }
  /* back along the near edge of the plaza to the bridge */
  var PLAZA_BACK = [[1050, 372], [1000, 372], [950, 372], [905, 366], [872, 357]];
  var WORKER = build_([ringArt(EAST_DEG)].concat(OUT, PLAZA, PLAZA_BACK, BACK, [ringArt(EAST_DEG)]));

  /* The rendering pipeline: from the gate up the west side of the ring to
     the DOM Garden, over the top to the CSS Foundry, down to the centre road
     and the Layout Workshop, then east to the Compositor Tower. */
  var RENDER = build_([].concat(
    arcArt(GATE_DEG, 205, 10), ['dom'],
    arcArt(205, 315, 10).slice(1), ['style'],
    arcArt(315, 360 + EAST_DEG, 10).slice(1),
    [[518, 380], [522, 400], [524, 420], 'layout', [540, 445], [556, 472],
     [578, 510], [610, 532], [645, 540], 'composite', [672, 537]]
  ));

  /* Bridge B is not driven by the cart; an envelope rides it whenever the job
     is split across two workers. */
  var BRIDGE_B = build_([[752, 462], [745, 485], [752, 505], [775, 515], [800, 527],
    [825, 545], [845, 565], [860, 586], [878, 600], [905, 605]]);

  /* `dwell` is the stop once the reader has already read this district. */
  function station(route, mark, id, dwell) {
    if (typeof mark === 'string') { dwell = id; id = mark; }
    var idx = typeof mark === 'number' ? mark : route.marks[mark];
    return { dist: route.cum[idx], id: id, dwell: dwell == null ? 0.9 : dwell };
  }

  var STATIONS = {
    arrive: [station(ARRIVE, 0, 'arrive', 1.0)],
    ringA:  [station(RING_A, 0, 'loop', 1.0)],
    ringB:  [station(RING_B, 'stack', 1.6)],
    worker: [
      station(WORKER, 'post', 1.4),
      station(WORKER, 'inbox', 1.0),
      station(WORKER, 'unpack', 1.0),
      station(WORKER, 'work', 2.0),
      station(WORKER, 'pack', 1.0),
      station(WORKER, 'reply', 1.4)
    ],
    render: [
      station(RENDER, 'dom', 1.0),
      station(RENDER, 'style', 1.0),
      station(RENDER, 'layout', 1.0),
      station(RENDER, 'composite', 1.6)
    ]
  };

  /* Which write-up a station shows. The same stop can mean different things:
     the gate of the loop in chunked mode is where the lesson about yielding
     belongs, and both bridge crossings share one write-up. */
  function topicOf(stationId, s) {
    if ((stationId === 'loop' || stationId === 'stack') && s && s.tripMode === 'chunked') return 'yield';
    if (stationId === 'post' || stationId === 'reply') return 'bridge';
    return stationId;
  }

  /* ---- palette ----------------------------------------------------------- */

  /* Lifted from the concept art: pastel, chalky, low contrast. */
  var C = {
    sea:     '#a9dbe0',
    seaDeep: '#8ccbd3',
    grass:   '#b4dc9f',
    grass2:  '#a3d293',
    cliff:   '#d4c8bc',
    cliff2:  '#c2b5a8',
    path:    '#efe5d3',
    pathEdge:'#dccfba',
    lav:     '#b8a9e6',
    lavDeep: '#8f7fd0',
    peach:   '#f2b9a0',
    mint:    '#a9dcc0',
    sky:     '#a9c9ef',
    butter:  '#f4d79a',
    rose:    '#e79a9a',
    clay:    '#c99a6e',
    stone:   '#e4dccf',
    ink:     '#4a4540',
    /* district accents, deeper so text and washes stay legible */
    dDocks:  '#4f86a8',
    dLoop:   '#a0743c',
    dYield:  '#c0863a',
    dStack:  '#b55a4a',
    dBridge: '#8a68c4',
    dMill:   '#c4684a',
    dMill2:  '#7f62c0',
    dDom:    '#4f9160',
    dStyle:  '#b0773e',
    dLayout: '#7a6bc0',
    dComp:   '#5a72c8'
  };

  /* ---- districts (clickable, narrated) ----------------------------------- */

  /* click targets, in art pixels; `label` is the centre of the name plate
     painted into the art, where the live chips sit */
  function at(px, py) { return I(px, py); }
  var POS = {
    arrive: at(240, 560), loop: at(520, 250), stack: at(362, 272), yield: at(402, 345),
    bridge: at(815, 360), work: at(985, 300),
    inbox: at(900, 330), unpack: at(935, 345), pack: at(1050, 345), nodom: at(866, 372), work2: at(965, 540), dom: at(290, 190),
    style: at(670, 140), layout: at(405, 420), composite: at(670, 400)
  };
  var LABEL = {
    arrive: [195, 598], loop: [515, 300], dom: [305, 203], style: [690, 208],
    layout: [397, 493], composite: [643, 512], bridge: [825, 320], work: [920, 375],
    work2: [933, 629],
    /* not in the painting: plates drawn by us, just below the added models */
    stack: [350, 302], yield: [345, 352],
    inbox: [905, 300], unpack: [880, 374], pack: [1088, 318]
  };
  /* added plates sit close together, so their chips go beside them (+1 right, -1 left) */
  /* small tags (the yield signal, the worker's steps): where each leader points, art px */
  var SPOT = { yield: [402, 340], inbox: [900, 332], unpack: [935, 347], pack: [1050, 347] };
  var ADDED = { stack: -1, yield: 'tag', inbox: 'tag', unpack: 'tag', pack: 'tag' };

  var DISTRICTS = [
    {
      id: 'arrive', name: 'Network Docks', x: POS.arrive[0], y: POS.arrive[1], r: 3.6, color: C.dDocks,
      tag: 'Everything arrives as a task',
      short: 'Clicks, network responses and timers all land here and wait in line.',
      body: 'A browser tab does not run your code whenever it likes. Every outside event — a click, a fetch that finished, a timer that fired — is turned into a task and put in a queue. The cart leaving the docks is one click on a "Process image" button, with an 8 MB photo attached. It already waited a little: the click landed 1 ms after a vsync, while the main thread was still drawing that frame, and a running task is never interrupted.'
    },
    {
      id: 'loop', name: 'Event Loop', x: POS.loop[0], y: POS.loop[1], r: 3.4, color: C.dLoop,
      tag: 'One task at a time',
      short: 'The main thread takes one task, runs it to the end, then checks if a frame is due.',
      body: 'This ring is the event loop, and it is literally a loop: take the oldest task, run it until the call stack is empty, drain the microtask queue (resolved promises), and then — if a vsync has passed — render a frame. Only then does it take the next task. The display wants a frame every 16.7 ms. Every millisecond a task holds the cart is a millisecond the page cannot paint, scroll or answer a tap. Watch the clock: it only ticks when a frame is drawn.'
    },
    {
      id: 'stack', name: 'Call Stack Yard', x: POS.stack[0], y: POS.stack[1], r: 1.6, color: C.dStack,
      tag: 'Run to completion',
      short: 'JavaScript on the main thread runs until it finishes. Nothing can cut in.',
      body: 'The crates stacked here are the call stack: the click handler, the processImage() it called, the loop inside that. On this trip the whole job runs as one task, about 480 ms of arithmetic over millions of pixels. For all of it the event loop is stuck at this yard. Look at the timeline on the panel: around 28 vsyncs come and go without a frame, the clock on the tower stops, and a second tap would wait more than 400 ms. Browsers call any task over 50 ms a long task.'
    },
    {
      id: 'yield', name: 'Yield Signal', x: POS.yield[0], y: POS.yield[1], r: 1.2, color: C.dYield,
      tag: 'Chunk, yield, repeat',
      short: 'The same job, cut into small tasks, so frames can slip in between them.',
      body: 'This time processImage() handles a slice of about 8 ms, then queues the rest as a new task and returns. The call stack empties, the loop gets control back, and if a vsync has passed it renders before taking the next slice. Each lap of the ring stands for a batch of slices. The frame row stays green, but the job takes longer: frames and re-queuing now share the same thread. Queue slices with postMessage or scheduler.yield(), not setTimeout, which the spec clamps to 4 ms once nested five deep.'
    },
    {
      id: 'bridge', name: 'postMessage Bridge', x: POS.bridge[0], y: POS.bridge[1], r: 2.6, color: C.dBridge,
      tag: 'Copy, or hand over',
      short: 'A worker shares nothing with the page. Every byte has to cross this bridge.',
      body: 'postMessage() copies the data with the structured clone algorithm, which serialises it on one side and rebuilds it on the other. 8 MB of pixels costs around 19 ms each way, on the main thread. Pass the ArrayBuffer in the transfer list instead and nothing is copied: ownership moves, and the page\'s copy is detached. Toggle Transfer and watch the pile left at the bridgehead. The answer comes back the same way and waits in the task queue for a gap between frames.'
    },
    {
      id: 'inbox', name: 'Worker Inbox', x: POS.inbox[0], y: POS.inbox[1], r: 1.5, color: C.dMill,
      tag: 'Its own task queue',
      short: 'The message waits in the worker\'s own queue until the worker is ready for it.',
      body: 'A worker has its own event loop and its own task queue, just like the page. postMessage drops the envelope here and returns at once; the main thread is already free. On the first trip the worker is not running yet: new Worker() has to fetch worker.js, parse it and run its top level, about 28 ms, and the message waits in this inbox the whole time. On later trips the worker is already up, so the wait is zero. That is why apps create their workers early, before the first click. And a worker still runs one task at a time: post a second message while it is busy and that one waits here too.'
    },
    {
      id: 'unpack', name: 'Unpacking Bench', x: POS.unpack[0], y: POS.unpack[1], r: 1.5, color: C.dMill,
      tag: 'Structured clone, other side',
      short: 'The worker rebuilds its own copy of the pixels before it can touch them.',
      body: 'A worker shares no memory with the page, so what arrived is a serialised copy. Before onmessage runs, the worker deserialises it into fresh objects in its own heap. For 8 MB of pixels that is a few milliseconds, and it grows with the size: drag Image data and watch this charge move. Turn on Transfer and there is nothing to rebuild. The ArrayBuffer\'s memory simply changes owner, the page\'s copy becomes empty (detached), and this step costs almost nothing.'
    },
    {
      id: 'work', name: 'Web Worker Mill', x: POS.work[0], y: POS.work[1], r: 4.0, color: C.dMill,
      tag: 'A second thread',
      short: 'Same work, same speed, but on a thread that never has to draw a frame.',
      body: 'These are the gears: the job itself. A dedicated worker is a whole separate JavaScript thread with its own event loop, its own heap and no DOM. It is not faster at arithmetic: the job still takes about 480 ms. The difference is where. While the gears here turn, the main thread is free and keeps rendering every frame. Look at the panel: the frame row stays green the whole way.'
    },
    {
      id: 'pack', name: 'Packing Dock', x: POS.pack[0], y: POS.pack[1], r: 1.5, color: C.dMill,
      tag: 'No DOM in here',
      short: 'The worker cannot touch the page, so it packs the result and posts it back.',
      body: 'A worker has no document, no window.document and no DOM: the sign by the dock says so. It cannot write the result into the page itself, however close it is to done. So it calls postMessage(result), which serialises the pixels again, this time on the worker\'s own thread, and the reply crosses the bridge as a task for the main thread. With Transfer on, the buffer is handed back instead of copied. Whatever a worker computes, only the main thread can put it on screen.'
    },
    {
      id: 'work2', name: 'Second Worker Mill', x: POS.work2[0], y: POS.work2[1], r: 4.0, color: C.dMill2,
      tag: 'Parallel, if you split it',
      short: 'Two workers can each take half of the image, on two cores at once.',
      body: 'Workers can run truly in parallel on a multi-core CPU. Turn on "2 workers" and the job is split: each mill gets half the pixels over its own bridge, and the total drops to a bit over half. Each half costs a little extra for overlapping edges. navigator.hardwareConcurrency says how many cores there are, but each worker also costs memory and start-up time, so past a few the gains fall off. The cart follows mill A; the envelope on this bridge is the other half.'
    },
    {
      id: 'dom', name: 'DOM Garden', x: POS.dom[0], y: POS.dom[1], r: 4.2, color: C.dDom,
      tag: 'Only the page may touch it',
      short: 'Only the main thread can change the DOM, so every result ends up back here.',
      body: 'The trees here are planted as a tree on purpose: the DOM is a tree of nodes, and changing it marks part of the tree as dirty. Workers cannot touch it at all. There is no document inside a worker. So wherever the pixels were processed, the last step is always on the main thread: write the result into the page. Drag DOM nodes up and watch this cost grow, then style and layout grow after it.'
    },
    {
      id: 'style', name: 'CSS Foundry', x: POS.style[0], y: POS.style[1], r: 3.4, color: C.dStyle,
      tag: 'Selectors → computed style',
      short: 'Every dirty element gets its final CSS worked out again.',
      body: 'Recalculate Style matches selectors against each dirty element and works out its computed values: colours, sizes, fonts, all of it. It runs at the start of a frame, not when you change the DOM. That is why a write right after a vsync waits for the next one, and why this bar can include a few milliseconds of waiting. Read a layout property such as offsetHeight in the middle of a task and the browser has to do this right then: forced synchronous layout.'
    },
    {
      id: 'layout', name: 'Layout Workshop', x: POS.layout[0], y: POS.layout[1], r: 3.0, color: C.dLayout,
      tag: 'Boxes get sizes',
      short: 'Every box gets a position and a size, and changes ripple to its neighbours.',
      body: 'The stacked blocks are layout boxes. Layout, also called reflow, works out where each one goes and how big it is. One wider element can push every sibling after it, so the cost grows with how much of the tree is dirty, not just with what you changed. Like style, it runs on the main thread. A worker can do the maths that decides what goes in the page, but it can never do this part.'
    },
    {
      id: 'composite', name: 'Compositor Tower', x: POS.composite[0], y: POS.composite[1], r: 3.4, color: C.dComp,
      tag: 'Paint → layers → pixels',
      short: 'Paint records drawing commands, and the compositor stacks the layers into pixels.',
      body: 'Paint turns boxes into lists of drawing commands. The compositor, on a thread of its own, rasterises them into layers and stacks the layers for the GPU. Any JavaScript animation on the page needs the main thread for every frame, so it freezes whenever a long task holds the cart. A pure CSS transform or opacity animation can run on the compositor alone and keep moving through a long task. That is the other way to keep a page smooth.'
    }
  ];

  var DISTRICT_BY_ID = {};
  DISTRICTS.forEach(function (d) { DISTRICT_BY_ID[d.id] = d; d.label = LABEL[d.id] || null; d.added = ADDED[d.id] || 0; d.spotArt = SPOT[d.id] || null; });

  /* Topics a trip can stop at; the tour is done once all have been read. */
  var TOUR_TOPICS = ['arrive', 'loop', 'stack', 'yield', 'bridge', 'work', 'dom', 'style', 'layout', 'composite'];

  /* First-visit stop, in seconds, scaled to how much there is to read. */
  function readSeconds(topic) {
    var d = DISTRICT_BY_ID[topic];
    if (!d) return 9;
    var words = (d.short + ' ' + d.body).split(/\s+/).length;
    return Math.min(26, Math.max(9, words / 3.8 + 3.5));
  }

  /* ---- buildings and props ----------------------------------------------- */

  var buildings = [];
  var props = [];

  function put(o) { buildings.push(o); return o; }

  function distToRoutes(x, y) {
    var best = 1e9;
    [ARRIVE, RING_A, RING_B, WORKER, RENDER, BRIDGE_B].forEach(function (r) {
      r.segs.forEach(function (s) {
        var vx = s.b.x - s.a.x, vy = s.b.y - s.a.y;
        var t = ((x - s.a.x) * vx + (y - s.a.y) * vy) / (vx * vx + vy * vy);
        t = Math.max(0, Math.min(1, t));
        var d = Math.hypot(x - (s.a.x + vx * t), y - (s.a.y + vy * t));
        if (d < best) best = d;
      });
    });
    return best;
  }

  function insidePoly(poly, x, y) {
    var c = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if (((a[1] > y) !== (b[1] > y)) && (x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0])) c = !c;
    }
    return c;
  }

  /* where the copied pixels pile up when postMessage clones instead of
     transferring */
  var CLONE_PILE = I(782, 438);

  /* the DOM tree, planted: root, two children, four grandchildren */
  var DOM_TREE = (function () {
    var root = I(300, 150), out = [];
    var kids = [I(230, 200), I(370, 190)];
    var grand = [I(170, 250), I(240, 262), I(345, 236), I(420, 222)];
    out.push({ p: root, parent: null, depth: 0 });
    kids.forEach(function (k) { out.push({ p: k, parent: root, depth: 1 }); });
    grand.forEach(function (g, i) { out.push({ p: g, parent: kids[i >> 1], depth: 2 }); });
    return out;
  })();

  /* What the reader frames with ⤢: the islands' projected bounding box. */
  var FIT = null;

  function build() {
    if (FIT) return;
    /* the buildings are painted into the backdrop; only the two places the
       art does not have get a model of their own (render.js draws them) */
    var sy = DISTRICT_BY_ID.stack, yl = DISTRICT_BY_ID.yield;
    put({ kind: 'stackyard', x: sy.x, y: sy.y });
    put({ kind: 'signal', x: yl.x, y: yl.y });

    /* frame the painted islands, not the whole canvas of sea */
    var a = toScreen(10, 30), b = toScreen(1130, 720);
    FIT = { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, w: b.x - a.x, h: b.y - a.y };
    global.World.fit = FIT;
  }

  /* low-poly clouds drifting around the islands, in art pixels */
  var CLOUDS = [[160, 60, 1.5], [420, 55, 0.6], [820, 55, 0.9], [1010, 95, 1.6],
                [905, 170, 0.55], [1110, 200, 0.6], [55, 200, 0.75]].map(function (c) {
    var g = I(c[0], c[1]);
    return { x: g[0], y: g[1], s: c[2] };
  });

  global.World = {
    I: I,
    art: ART, toScreen: toScreen, ringArt: ringArt, ringArtGeom: RING_ART,
    islands: ISLANDS,
    ringC: RING_C, ringR: RING_R, ringPt: ringPt,
    gate: GATE, east: EAST,
    routes: { arrive: ARRIVE, ringA: RING_A, ringB: RING_B, worker: WORKER, render: RENDER, bridgeB: BRIDGE_B },
    stations: STATIONS,
    topicOf: topicOf,
    tourTopics: TOUR_TOPICS,
    districts: DISTRICTS,
    districtById: DISTRICT_BY_ID,
    readSeconds: readSeconds,
    buildings: buildings,
    props: props,
    clouds: CLOUDS,
    domTree: DOM_TREE,
    clonePile: CLONE_PILE,
    palette: C,
    distToRoutes: distToRoutes,
    insidePoly: insidePoly,
    fit: null,
    build: build
  };
})(window);
