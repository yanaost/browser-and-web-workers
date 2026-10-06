/* render.js: the painting, with the live layer drawn over it.
 *
 * The scenery is the concept art itself (2banR.jpg): every building, tree,
 * cliff and road you see is painted. The world grid is fitted to the picture
 * (World.I maps art pixels onto it), the roads the cart drives are traced
 * from the painted paths, and everything that moves or reads the model is
 * drawn on top, in art-pixel coordinates.
 *
 * There is still no z-buffer. Things with a footprint (the cart, the envelope,
 * the Call Stack Yard, the Yield Signal, the clone pile) go into one list
 * sorted by x + y. Painted buildings that the cart drives behind are cut out
 * of the picture as polygons ("occluders") and redrawn in that same sorted
 * pass, so the clock tower hides the cart on the far side of the ring and the
 * arch frames it as it passes under.
 *
 * The instruments read the model at the cart's display time (Sim.tau()):
 *   clock tower      the hands move one step per frame actually painted
 *   call-stack yard  one crate per frame on the main thread's call stack
 *   yield signal     red while a task holds the thread, green between tasks
 *   mill gears       turn, and the chimneys smoke, only while that worker
 *                    is busy
 */
(function (global) {
  'use strict';

  var Iso = global.Iso, World = global.World, Sim = global.Sim, Model = global.Model;
  var P = Iso.project;
  var ART = World.art;
  var C = World.palette;

  var cam = null, ctx = null, t = 0;
  var labels = [];
  var showLabels = true;

  /* What the model says right now. Filled once per frame by sample(). */
  var now = { tau: 0, busy: null, healthy: true, painted: 0, inTrip: false };

  function sample() {
    var s = Sim.state;
    now.inTrip = !!(s.running && s.plan && !s.finished);
    if (!now.inTrip) {
      now.tau = 0; now.busy = null; now.healthy = true;
      return;
    }
    now.tau = Sim.tau();
    now.busy = Model.busyAt(s.plan, now.tau);
    /* only the stretch between the click and the result is in question */
    now.healthy = now.tau <= s.plan.click || now.tau >= s.plan.done ||
                  Model.healthyAt(s.plan, now.tau);
    now.painted = Model.paintedBy(s.plan, now.tau).painted;
  }

  /* ------------------------------------------------------------- backdrop */

  /* The picture, loaded once. ART_C is the picture with the generator's
     watermark painted over and its edges feathered; FIELD is a tiny, blurred,
     edge-extended copy that fills the screen beyond the picture so there is
     never a hard border. Only drawImage is used: getImageData would throw on
     a page opened from file://. */
  var IMG = new Image(), ART_C = null, FIELD = null, FIELD_PAD = 0, FIELD_S = 16;
  IMG.onload = buildBackdrop;
  IMG.src = '2banR.jpg';

  function canvasOf(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function buildBackdrop() {
    var W = ART.w, H = ART.h;
    var a = canvasOf(W, H), x = a.getContext('2d');
    x.drawImage(IMG, 0, 0, W, H);

    /* the generator's watermark sits on open water in the bottom-right
       corner: smear the clean water of the bottom row up over it, feathered
       into the picture above and to the left */
    var patch = canvasOf(128, 72), px = patch.getContext('2d');
    px.drawImage(IMG, 1040, 780, 128, 3, 0, 0, 128, 72);
    px.globalCompositeOperation = 'destination-in';
    var g = px.createLinearGradient(0, 0, 0, 72);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.35, '#000'); g.addColorStop(1, '#000');
    px.fillStyle = g; px.fillRect(0, 0, 128, 72);
    g = px.createLinearGradient(0, 0, 128, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.22, '#000'); g.addColorStop(1, '#000');
    px.fillStyle = g; px.fillRect(0, 0, 128, 72);
    x.drawImage(patch, 1040, 712);

    /* the blurred field, from the patched picture */
    var step = a, sw = W, sh = H;
    while (sw > W / FIELD_S + 1) {
      var nw = Math.max(1, Math.round(sw / 2)), nh = Math.max(1, Math.round(sh / 2));
      var c = canvasOf(nw, nh);
      c.getContext('2d').drawImage(step, 0, 0, sw, sh, 0, 0, nw, nh);
      step = c; sw = nw; sh = nh;
    }
    FIELD_S = W / sw;
    var pad = FIELD_PAD = 240;
    var f = canvasOf(sw + pad * 2, sh + pad * 2), fx = f.getContext('2d');
    fx.imageSmoothingEnabled = false;
    fx.drawImage(step, pad, pad);
    /* stretch an edge one pixel in from each side outwards, then the rows */
    fx.drawImage(step, 1, 0, 1, sh, 0, pad, pad, sh);
    fx.drawImage(step, sw - 2, 0, 1, sh, pad + sw, pad, pad, sh);
    fx.drawImage(f, 0, pad + 1, f.width, 1, 0, 0, f.width, pad);
    fx.drawImage(f, 0, pad + sh - 2, f.width, 1, 0, pad + sh, f.width, pad);
    /* soften the stretched edges (clouds would otherwise streak) */
    var f2 = canvasOf(f.width, f.height), f2x = f2.getContext('2d');
    f2x.drawImage(f, 0, 0);
    if ('filter' in f2x) {
      f2x.filter = 'blur(5px)';
      f2x.drawImage(f, 0, 0);
      f2x.filter = 'none';
    }
    FIELD = f2;

    /* feather the sharp picture's edges into the field */
    x.globalCompositeOperation = 'destination-out';
    function fade(x0, y0, x1, y1, rx, ry, rw, rh) {
      var gg = x.createLinearGradient(x0, y0, x1, y1);
      gg.addColorStop(0, 'rgba(0,0,0,1)'); gg.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = gg; x.fillRect(rx, ry, rw, rh);
    }
    var E = 70;
    fade(0, 0, E, 0, 0, 0, E, H);
    fade(W, 0, W - E, 0, W - E, 0, E, H);
    fade(0, 0, 0, E, 0, 0, W, E);
    fade(0, H, 0, H - E, 0, H - E, W, E);
    ART_C = a;
  }

  function drawBackdrop(w, h) {
    ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
    ctx.fillStyle = '#cfe8e6';
    ctx.fillRect(0, 0, w, h);
    if (!ART_C) return;
    worldTransform();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    var s = FIELD_S * ART.K;
    ctx.drawImage(FIELD, ART.x0 - FIELD_PAD * s, ART.y0 - FIELD_PAD * s, FIELD.width * s, FIELD.height * s);
    ctx.drawImage(ART_C, ART.x0, ART.y0, ART.w * ART.K, ART.h * ART.K);
  }

  function worldTransform() {
    ctx.setTransform(cam.scale * cam.dpr, 0, 0, cam.scale * cam.dpr, cam.ox * cam.dpr, cam.oy * cam.dpr);
  }

  /* Work in art pixels: (0,0) is the picture's top-left corner. */
  function artSpace() {
    worldTransform();
    ctx.transform(ART.K, 0, 0, ART.K, ART.x0, ART.y0);
  }

  function artPath(list) {
    ctx.moveTo(list[0][0], list[0][1]);
    for (var i = 1; i < list.length; i++) ctx.lineTo(list[i][0], list[i][1]);
    ctx.closePath();
  }

  /* -------------------------------------------------------------- occluders */

  /* Painted things the cart can pass behind, cut from the picture. `base` is
     where the thing meets the ground, which is what it sorts by. */
  var OCCLUDERS = [
    { name: 'tower', base: [525, 270], poly: [[525, 108], [530, 120], [533, 135], [548, 145], [555, 160],
      [560, 168], [562, 183], [560, 205], [565, 210], [562, 228], [562, 245], [570, 236], [582, 240],
      [585, 262], [570, 275], [548, 280], [520, 282], [492, 278], [470, 272], [466, 250], [478, 235],
      [487, 232], [487, 210], [487, 183], [490, 168], [497, 150], [512, 135], [517, 120]] },
    { name: 'crystal', base: [668, 450], poly: [[660, 302], [675, 315], [690, 345], [700, 365], [712, 372],
      [718, 385], [720, 410], [722, 440], [733, 450], [712, 470], [680, 480], [640, 478], [605, 462],
      [598, 440], [612, 425], [618, 385], [630, 375], [640, 335], [650, 312]] },
    { name: 'arch', base: [262, 552], poly: [[224, 471], [242, 470], [280, 477], [300, 491], [312, 507],
      [312, 565], [300, 567], [290, 562], [235, 547], [224, 542]],
      hole: [[246, 548], [246, 522], [252, 511], [262, 508], [271, 513], [276, 523], [276, 557]] }
  ];
  OCCLUDERS.forEach(function (o) { var g = World.I(o.base[0], o.base[1]); o.k = g[0] + g[1]; });

  function drawOccluder(o) {
    if (!ART_C) return;
    artSpace();
    ctx.save();
    ctx.beginPath();
    artPath(o.poly);
    if (o.hole) artPath(o.hole);
    ctx.clip('evenodd');
    ctx.drawImage(ART_C, 0, 0, ART.w, ART.h);
    ctx.restore();
    worldTransform();
  }

  /* ------------------------------------------------------------ instruments */

  /* Clock tower: the painted faces get a clean dial and live hands. The
     minute hand moves one step for every frame the model painted. */
  var FACES = [
    { x: 511.8, y: 198.3, rx: 8.6, ry: 10.2, shear: 0.32 },
    { x: 545.8, y: 197.0, rx: 6.0, ry: 9.6, shear: -0.32 }
  ];
  function drawClockHands() {
    var hand = now.inTrip ? now.painted * Math.PI / 30 : t * 0.5;
    artSpace();
    FACES.forEach(function (f) {
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.transform(f.rx / 10, f.shear * f.rx / 10, 0, f.ry / 10, 0, 0);
      ctx.fillStyle = '#f5f1ea';
      ctx.beginPath(); ctx.arc(0, 0, 10, 0, 6.2832); ctx.fill();
      ctx.strokeStyle = 'rgba(120,96,70,0.7)';
      ctx.lineWidth = 0.9;
      for (var i = 0; i < 12; i++) {
        var a = i / 12 * 6.2832, r0 = i % 3 ? 8 : 6.8;
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
        ctx.lineTo(Math.cos(a) * 9.2, Math.sin(a) * 9.2); ctx.stroke();
      }
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#5a4634';
      ctx.lineWidth = 1.6;
      var ha = hand / 12 - Math.PI / 2;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(ha) * 4.6, Math.sin(ha) * 4.6); ctx.stroke();
      ctx.lineWidth = 1.1;
      var ma = hand - Math.PI / 2;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(ma) * 7.6, Math.sin(ma) * 7.6); ctx.stroke();
      ctx.fillStyle = '#5a4634';
      ctx.beginPath(); ctx.arc(0, 0, 1.1, 0, 6.2832); ctx.fill();
      ctx.lineCap = 'butt';
      ctx.restore();
    });
  }

  /* Mill gears, painted over the painted ones, on the wall's plane. */
  var MILLS = [
    { gears: [[965, 268.75, 17], [993, 293.75, 17]], col: '#a8835e',
      chimneys: [[976, 182], [1009, 195], [1031, 227]] },
    { gears: [[952.5, 526, 16], [980, 550, 15.5]], col: '#a07d5a',
      chimneys: [[959, 439], [993, 454], [1022, 474]] }
  ];
  var millAng = [0, 0.4];

  function millBusy(which) {
    var s = Sim.state;
    var active = which === 0 || s.workers > 1;
    var seg = now.busy && now.busy.workers && now.busy.workers[which];
    return active && !!seg && seg.kind === 'job' && s.tripMode === 'worker';
  }

  /* The worker's other steps, on Mill A's plaza, read from its timeline:
     the script loading while the message waits in the inbox, the pixels
     unpacked onto the bench, the reply packed at the dock. */
  function workerSeg() {
    var seg = Sim.state.tripMode === 'worker' && now.busy && now.busy.workers && now.busy.workers[0];
    if (!seg) return null;
    return { kind: seg.kind, label: seg.label || '',
             f: Math.max(0, Math.min(1, (now.tau - seg.t0) / Math.max(0.001, seg.t1 - seg.t0))) };
  }

  function drawWorkerSteps() {
    var w = workerSeg();
    if (!w) return;
    var s = Sim.state;
    if (w.kind === 'spawn') {
      /* worker.js loading: a scroll and a progress bar over the inbox */
      artSpace();
      var x = 900, y = 316;
      ctx.fillStyle = 'rgba(253,250,242,0.95)';
      ctx.strokeStyle = 'rgba(150,128,96,0.7)';
      ctx.lineWidth = 0.8;
      roundRect(x - 22, y - 9, 44, 18, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#4a4238';
      ctx.font = '600 6.5px ' + SANS;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('worker.js', x, y - 3);
      obstacleArt(x, y, 46, 20);
      ctx.fillStyle = 'rgba(196,104,74,0.2)';
      roundRect(x - 17, y + 2.5, 34, 3, 1.5); ctx.fill();
      ctx.fillStyle = '#c4684a';
      roundRect(x - 17, y + 2.5, 34 * w.f, 3, 1.5); ctx.fill();
      return;
    }
    if (w.kind !== 'clone') return;
    var unpack = /deserialise/.test(w.label);
    var at = World.I(unpack ? 938 : 1046, unpack ? 342 : 342);
    var n = crates(s.dataKB / Math.max(1, s.workers));
    var k = Math.ceil(n * w.f);
    worldTransform();
    for (var i = 0; i < k; i++) {
      var col = i % 3, row = (i / 3) | 0;
      Iso.box(ctx, { x: at[0] - 0.5 + col * 0.36, y: at[1] - 0.3 + (row % 2) * 0.36, z: 0.02 + ((i / 6) | 0) * 0.32,
        w: 0.32, d: 0.32, h: 0.3, color: unpack ? (i % 2 ? '#c9b6e6' : '#b8a9e6') : (i % 2 ? '#f5c6a0' : '#efb48e') });
    }
  }

  /* The sign by the packing dock: there is no DOM on this island. */
  function drawNoDomSign() {
    artSpace();
    var x = 1082, y = 384;
    ctx.fillStyle = '#b89c7c';
    ctx.fillRect(x - 1, y - 22, 2, 22);
    ctx.fillStyle = 'rgba(50,62,56,0.18)';
    ctx.beginPath(); ctx.ellipse(x + 2, y, 5, 2, 0, 0, 6.2832); ctx.fill();
    var bw = 44, bh = 16, bx = x - bw / 2, by = y - 36, cy = by + bh / 2;
    ctx.fillStyle = '#fdfaf2';
    ctx.strokeStyle = '#c0503f';
    ctx.lineWidth = 1.1;
    roundRect(bx, by, bw, bh, 3); ctx.fill(); ctx.stroke();
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(bx + 9, cy, 5, 0, 6.2832); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx + 5.5, cy + 3.5); ctx.lineTo(bx + 12.5, cy - 3.5); ctx.stroke();
    ctx.fillStyle = '#4a4238';
    ctx.font = '700 8.5px ' + SANS;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('DOM', bx + 28, cy + 0.5);
    obstacleArt(x, y - 22, bw + 4, 40);
  }

  function gear(r, ang, col) {
    var teeth = 12;
    ctx.fillStyle = col;
    ctx.beginPath();
    for (var i = 0; i < teeth * 2; i++) {
      var a0 = ang + i / (teeth * 2) * 6.2832, a1 = ang + (i + 1) / (teeth * 2) * 6.2832;
      var rr = i % 2 ? r * 0.8 : r;
      ctx.lineTo(Math.cos(a0) * rr, Math.sin(a0) * rr);
      ctx.lineTo(Math.cos(a1) * rr, Math.sin(a1) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = Iso.shade(col, 0.68);
    ctx.lineWidth = 0.9;
    ctx.stroke();
    ctx.fillStyle = Iso.shade(col, 0.72);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.62, 0, 6.2832); ctx.fill();
    ctx.fillStyle = Iso.shade(col, 1.1);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.5, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = Iso.shade(col, 0.7);
    ctx.lineWidth = 1.6;
    for (i = 0; i < 4; i++) {
      var q = ang + i * Math.PI / 4;
      ctx.beginPath(); ctx.moveTo(-Math.cos(q) * r * 0.5, -Math.sin(q) * r * 0.5);
      ctx.lineTo(Math.cos(q) * r * 0.5, Math.sin(q) * r * 0.5); ctx.stroke();
    }
    ctx.fillStyle = Iso.shade(col, 0.55);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.16, 0, 6.2832); ctx.fill();
  }

  function drawMills() {
    artSpace();
    MILLS.forEach(function (m, which) {
      var busy = millBusy(which);
      if (busy) millAng[which] += 0.05;
      var ang = millAng[which];
      m.gears.forEach(function (gq, i) {
        ctx.save();
        ctx.translate(gq[0], gq[1]);
        ctx.transform(0.92, 0.25, 0, 1, 0, 0);
        ctx.fillStyle = '#5f4a3a';
        ctx.beginPath(); ctx.arc(0, 0, gq[2] + 1, 0, 6.2832); ctx.fill();
        gear(gq[2], i ? -ang * 1.0 + 0.13 : ang, i ? Iso.shade(m.col, 1.06) : m.col);
        ctx.restore();
      });
      smoke(m.chimneys, busy ? 0.75 : 0);
    });
  }

  function smoke(list, alpha) {
    if (!alpha) return;
    list.forEach(function (c, i) {
      for (var k = 0; k < 3; k++) {
        var ph = (t * 0.45 + k / 3 + i * 0.21) % 1;
        ctx.fillStyle = Iso.rgba('#ffffff', alpha * (1 - ph));
        ctx.beginPath(); ctx.arc(c[0] - ph * 6, c[1] - 3 - ph * 22, 2.4 + ph * 6, 0, 6.2832); ctx.fill();
      }
    });
  }

  /* The pipeline stops light up while the cart is paying for them. */
  var DOM_CROWNS = [[280, 135], [350, 100], [410, 140], [220, 165], [240, 235], [180, 200], [320, 155]];
  function renderStep(id) {
    var s = Sim.state;
    return Sim.van.routeName === 'render' && s.station === id;
  }

  function glow(x, y, rx, ry, col, a) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, Iso.rgba(col, a));
    g.addColorStop(1, Iso.rgba(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, rx, 0, 6.2832); ctx.fill();
    ctx.restore();
  }

  function drawPipeline() {
    artSpace();
    var pulse = 0.5 + 0.5 * Math.sin(t * 5);
    if (renderStep('dom')) {
      /* the nodes the result touched are marked dirty */
      DOM_CROWNS.forEach(function (c, i) {
        glow(c[0], c[1], 24, 20, '#fff3a6', 0.5 + 0.35 * Math.sin(t * 5 + i));
      });
    }
    if (renderStep('style')) smoke([[702.5, 49], [734, 74]], 0.8);
    if (renderStep('layout')) glow(400, 425, 80, 50, '#e9ddff', 0.35 + 0.3 * pulse);
    if (renderStep('composite')) glow(668, 380, 70, 110, '#dff0ff', 0.3 + 0.3 * pulse);
  }

  /* A soft wash under the place the panel is talking about. */
  function drawHighlight(id, strong) {
    var d = World.districtById[id];
    if (!d) return;
    worldTransform();
    var p = P(d.x, d.y, 0);
    var R = d.r * Iso.TW * 1.2;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(1, 0.55);
    var g = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R);
    g.addColorStop(0, Iso.rgba(d.color, strong ? 0.28 : 0.16));
    g.addColorStop(1, Iso.rgba(d.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = Iso.rgba(d.color, strong ? 0.5 + 0.2 * Math.sin(t * 3) : 0.3);
    ctx.lineWidth = 2 / Math.max(0.5, cam.scale);
    ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.arc(0, 0, R * 0.8, 0, 6.2832); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /* ------------------------------------------- places the art does not have */

  /* Call Stack Yard. One crate per frame currently on the main thread's call
     stack, read from the model at the cart's display time. */
  function stackDepth() {
    var m = now.busy && now.busy.main;
    if (!m) return 0;
    switch (m.kind) {
      case 'task': return 2;     /* dispatchEvent → onclick */
      case 'micro': return 1;
      case 'job': return 4;      /* onclick → processImage → filterRow → pixel */
      case 'dom': return 3;
      case 'clone': return 2;    /* postMessage → serialize */
      case 'render': return 1;   /* rAF callback */
      default: return 0;
    }
  }

  function drawStackYard(b) {
    var k = 0.6, x = b.x, y = b.y;
    Iso.box(ctx, { x: x - 1.6 * k, y: y - 1.4 * k, z: 0, w: 3.2 * k, d: 2.8 * k, h: 0.18, color: '#ece4d6' });
    /* a timber crane */
    Iso.box(ctx, { x: x - 1.4 * k, y: y - 1.2 * k, z: 0.18, w: 0.3 * k, d: 0.3 * k, h: 4.2 * k, color: '#d9b896' });
    Iso.box(ctx, { x: x - 1.4 * k, y: y - 1.2 * k, z: 0.18 + 4.2 * k, w: 2.6 * k, d: 0.28 * k, h: 0.25 * k, color: '#d9b896' });
    var depth = stackDepth();
    var cols = ['#f5c6a0', '#c7b8ea', '#b9e3c6', '#b9d6f0', '#f4d79a'];
    for (var i = 0; i < depth; i++) {
      Iso.box(ctx, { x: x - 0.1 * k, y: y - 0.3 * k, z: 0.18 + i * 0.72 * k, w: 1.1 * k, d: 1.1 * k, h: 0.68 * k, color: cols[i % cols.length] });
    }
    var top = P(x + 0.45 * k, y + 0.25 * k, 0.18 + depth * 0.72 * k);
    var hook = P(x + 0.45 * k, y - 1.04 * k, 0.18 + 4.2 * k);
    ctx.strokeStyle = 'rgba(70,60,50,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hook.x, hook.y); ctx.lineTo(top.x, top.y); ctx.stroke();
  }

  /* Yield signal: red while a task holds the main thread, green otherwise. */
  function drawSignal(b) {
    var k = 0.6;
    Iso.box(ctx, { x: b.x - 0.12 * k, y: b.y - 0.12 * k, z: 0, w: 0.24 * k, d: 0.24 * k, h: 2.6 * k, color: '#d8c8b2' });
    Iso.box(ctx, { x: b.x - 0.3 * k, y: b.y - 0.3 * k, z: 2.6 * k, w: 0.6 * k, d: 0.6 * k, h: 1.2 * k, color: '#efe5d6' });
    var m = now.busy && now.busy.main;
    var red = m && m.kind !== 'render';
    var lamp = function (z, col, on) {
      var p = P(b.x + 0.3 * k, b.y + 0.02 * k, z);
      ctx.fillStyle = on ? col : 'rgba(120,108,92,0.25)';
      ctx.beginPath(); ctx.arc(p.x + 2.4, p.y, 2.7, 0, 6.2832); ctx.fill();
      if (on) { ctx.fillStyle = Iso.rgba(col, 0.25); ctx.beginPath(); ctx.arc(p.x + 2.4, p.y, 6, 0, 6.2832); ctx.fill(); }
    };
    lamp(3.5 * k, '#e5584a', !!red);
    lamp(2.95 * k, '#6cc46a', !red);
  }

  /* -------------------------------------------------------- small props  */

  function crates(kb) { return kb > 0 ? Math.max(1, Math.min(8, Math.round(kb / 1024))) : 0; }

  /* The copy that a structured clone leaves behind on the page's side. */
  function drawClonePile(pos) {
    var n = crates(Sim.state.pileKB);
    for (var i = 0; i < n; i++) {
      var col = i % 4, row = (i / 4) | 0;
      Iso.box(ctx, { x: pos[0] - 0.6 + col * 0.33, y: pos[1] - 0.2 + (row % 2) * 0.33, z: 0.02 + ((i / 8) | 0) * 0.3,
        w: 0.3, d: 0.3, h: 0.28, color: i % 2 ? '#c9b6e6' : '#b8a9e6' });
    }
  }

  /* An envelope riding bridge B: the other half of the image, posted to the
     second worker in parallel with the cart. */
  function drawEnvelope(p) {
    var q = P(p.x, p.y, 0.6 + Math.sin(t * 4) * 0.08);
    ctx.fillStyle = 'rgba(80,76,66,0.2)';
    Iso.disc(ctx, p.x, p.y, 0.02, 0.3);
    ctx.save();
    ctx.translate(q.x, q.y);
    ctx.scale(0.65, 0.65);
    ctx.fillStyle = '#fffaf0';
    ctx.strokeStyle = C.dMill2;
    ctx.lineWidth = 1.3;
    ctx.fillRect(-11, -8, 22, 15);
    ctx.strokeRect(-11, -8, 22, 15);
    ctx.beginPath(); ctx.moveTo(-11, -8); ctx.lineTo(0, 1); ctx.lineTo(11, -8); ctx.stroke();
    ctx.restore();
  }

  function envelopePos() {
    var s = Sim.state;
    if (s.tripMode !== 'worker' || s.workers < 2 || Sim.van.routeName !== 'worker') return null;
    var wr = World.routes.worker, br = World.routes.bridgeB;
    var f = Sim.van.dist / wr.total;
    /* out while the cart goes out, back while it comes back, hidden at the mill */
    var g;
    if (f < 0.4) g = f / 0.4;
    else if (f > 0.62) g = (1 - f) / 0.38;
    else return null;
    return br.at(g * br.total);
  }

  /* --------------------------------------------------------------- the cart
     The cart carries the state: the crates are the image's megabytes, and the
     gauge on its flank is the longest main-thread task of the step it just
     paid for, against the 16.7 ms a frame allows. It is drawn at half size
     so it fits the painted roads. */

  var MODE_COLOR = { main: '#d07a5e', chunked: '#d9a441', worker: '#8f7fd0' };
  var CS = 0.5;

  function drawVan(v) {
    var s = Sim.state;
    var hx = v.dx, hy = v.dy;
    var z = v.z || 0, k = CS;

    ctx.fillStyle = 'rgba(60,56,50,0.25)';
    Iso.disc(ctx, v.x, v.y, z + 0.02, 1.0 * k);

    Iso.orientedBox(ctx, { x: v.x, y: v.y, z: z + 0.16 * k, hx: hx, hy: hy, len: 2.4 * k, wid: 1.2 * k, h: 0.32 * k, color: '#6b6f7a' });
    Iso.orientedBox(ctx, { x: v.x - hx * 0.35 * k, y: v.y - hy * 0.35 * k, z: z + 0.48 * k, hx: hx, hy: hy, len: 1.6 * k, wid: 1.15 * k, h: 0.9 * k, color: '#fbf6ea' });
    Iso.orientedBox(ctx, { x: v.x + hx * 0.82 * k, y: v.y + hy * 0.82 * k, z: z + 0.48 * k, hx: hx, hy: hy, len: 0.8 * k, wid: 1.05 * k, h: 0.74 * k,
      color: MODE_COLOR[s.tripMode] || '#d07a5e' });

    /* gauge on the camera-facing flank */
    var frac = Math.min(1, s.gaugeMs / Model.FRAME_MS);
    var over = s.gaugeMs > Model.FRAME_MS;
    var px = -hy, py = hx;
    var side = (px + py) > 0 ? 1 : -1;
    var gx = v.x - hx * 0.35 * k + px * side * 0.6 * k;
    var gy = v.y - hy * 0.35 * k + py * side * 0.6 * k;
    var GLEN = 1.4 * k;
    Iso.orientedBox(ctx, { x: gx, y: gy, z: z + 0.66 * k, hx: hx, hy: hy, len: GLEN, wid: 0.03, h: 0.4 * k, color: '#6d675c', edge: false });
    if (frac > 0) {
      Iso.orientedBox(ctx, {
        x: gx - hx * (GLEN * (1 - frac) / 2), y: gy - hy * (GLEN * (1 - frac) / 2),
        z: z + 0.68 * k, hx: hx, hy: hy, len: Math.max(0.05, GLEN * frac - 0.04), wid: 0.04, h: 0.32 * k,
        color: over ? '#e4643f' : frac > 0.6 ? '#e8b34a' : '#7fc06a', edge: false
      });
    }

    var n = crates(s.cargoKB);
    for (var i = 0; i < n; i++) {
      var row = i % 2, col = (i / 2) | 0;
      Iso.orientedBox(ctx, {
        x: v.x - hx * (0.85 - col * 0.38) * k + px * (row ? 0.27 : -0.27) * k,
        y: v.y - hy * (0.85 - col * 0.38) * k + py * (row ? 0.27 : -0.27) * k,
        z: z + 1.38 * k, hx: hx, hy: hy, len: 0.34 * k, wid: 0.38 * k, h: 0.32 * k,
        color: i % 3 === 0 ? '#c9b6e6' : i % 3 === 1 ? '#f5c6a0' : '#b9e3c6'
      });
    }

    ctx.fillStyle = '#3f3a34';
    [[0.75, 0.48], [0.75, -0.48], [-0.75, 0.48], [-0.75, -0.48]].forEach(function (o) {
      Iso.disc(ctx, v.x + (hx * o[0] + px * o[1]) * k, v.y + (hy * o[0] + py * o[1]) * k, z + 0.14 * k, 0.2 * k);
    });
  }

  /* -------------------------------------------------------------- labels  */

  /* Plates are sized like the ones painted into the art: a 30 px face with
     14 px type, in art pixels, so they zoom with the picture. Below ~10 px
     type they stop shrinking so they stay readable. */
  function plateFont() { return Math.max(10, 14 * ART.K * cam.scale); }
  /* the painted lettering is a humanist sans, medium, slightly narrow:
     Avenir Next at 90% width is the closest system font */
  var SANS = '"Avenir Next", Avenir, "Segoe UI", system-ui, sans-serif';
  var SQ = 0.9;
  function squeezed(text, x, y) {
    ctx.save(); ctx.translate(x, y); ctx.scale(SQ, 1); ctx.fillText(text, 0, 0); ctx.restore();
  }
  var MONO = 'ui-monospace, Menlo, Consolas, monospace';

  function plateDims(o) {
    var f = o.font;
    ctx.font = (o.bold ? '600 ' : '500 ') + f + 'px ' + (o.mono ? MONO : SANS);
    var tw = ctx.measureText(o.text).width * SQ, sw = 0;
    if (o.sub) { ctx.font = '500 ' + (f * 0.8) + 'px ' + SANS; sw = ctx.measureText(o.sub).width * SQ; }
    var h = o.sub ? f * 2.75 : f * 2.1;
    return { w: Math.max(tw, sw) + f * 1.4 + (o.icon ? f * 1.4 : 0), h: h, d: h * 0.15 };
  }

  function plateShape(x, y, w, h, c) {
    ctx.beginPath();
    ctx.moveTo(x + c, y); ctx.lineTo(x + w - c, y); ctx.lineTo(x + w, y + c);
    ctx.lineTo(x + w, y + h - c); ctx.lineTo(x + w - c, y + h); ctx.lineTo(x + c, y + h);
    ctx.lineTo(x, y + h - c); ctx.lineTo(x, y + c); ctx.closePath();
  }

  /* the art's cream plate: chamfered face on a darker base, glyph on the left */
  function paintedPlate(cx, cy, o) {
    var m = o.dims || plateDims(o), f = o.font;
    var w = m.w, h = m.h, d = m.d, c = h * 0.2, x = cx - w / 2, y = cy - h / 2;
    ctx.fillStyle = 'rgba(50,62,56,0.2)';
    plateShape(x + 1, y + d + 2, w, h, c); ctx.fill();
    ctx.fillStyle = o.edge ? Iso.mix('#d6c5a6', o.edge, 0.3) : '#d6c5a6';
    plateShape(x, y + d, w, h, c); ctx.fill();
    var g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#fdfaf2'); g.addColorStop(1, o.edge ? Iso.mix('#f2eadb', o.edge, 0.08) : '#f2eadb');
    ctx.fillStyle = g;
    plateShape(x, y, w, h, c); ctx.fill();
    ctx.strokeStyle = o.edge ? Iso.rgba(o.edge, 0.85) : 'rgba(150,128,96,0.6)';
    ctx.lineWidth = o.strong ? 1.8 : 1.1;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var tx = cx;
    if (o.icon) {
      ctx.fillStyle = '#5a4f42';
      ctx.font = (f * 1.15) + 'px ' + SANS;
      ctx.fillText(o.icon, x + f * 0.7 + f * 0.6, cy + 0.5);
      tx = cx + f * 0.7;
    }
    ctx.fillStyle = o.color || '#2f2a24';
    ctx.font = (o.bold ? '600 ' : '500 ') + f + 'px ' + (o.mono ? MONO : SANS);
    squeezed(o.text, tx, cy + (o.sub ? -f * 0.5 : 0.5));
    if (o.sub) {
      ctx.font = '500 ' + (f * 0.8) + 'px ' + SANS;
      ctx.fillStyle = o.subColor || 'rgba(88,80,68,0.85)';
      squeezed(o.sub, tx, cy + f * 0.72);
    }
    return m;
  }

  /* Screen rects of everything fixed (painted plates, our plates, chips),
     so the cart's moving plate can steer clear of them. */
  var obstacles = [];
  function obstacle(cx, cy, w, h) { obstacles.push({ ax: cx, sy: cy, boxW: w, boxH: h }); }
  function obstacleArt(px, py, w, h) {
    var p = World.toScreen(px, py), u = ART.K * cam.scale;
    obstacle(p.x * cam.scale + cam.ox, p.y * cam.scale + cam.oy, w * u, h * u);
  }

  function drawLabels() {
    ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
    labels.sort(function (a, b) { return (b.pri || 0) - (a.pri || 0); });

    var placed = obstacles.slice();
    var i;
    for (i = 0; i < labels.length; i++) {
      var L = labels[i];
      var p = P(L.x, L.y, L.z);
      L.ax = p.x * cam.scale + cam.ox;
      L.ay = p.y * cam.scale + cam.oy;
      L.font = plateFont() * (L.scale || 1);
      L.dims = plateDims(L);
      L.boxW = L.dims.w; L.boxH = L.dims.h + L.dims.d;
      L.sy = L.ay - (L.lift || 0) - L.boxH / 2;
      for (var tries = 0; tries < 10 && overlaps(L, placed); tries++) L.sy -= L.boxH * 0.92;
      placed.push(L);
    }
    for (i = 0; i < labels.length; i++) drawPlate(labels[i]);
  }

  function overlaps(L, placed) {
    for (var i = 0; i < placed.length; i++) {
      var o = placed[i];
      if (Math.abs(L.ax - o.ax) < (L.boxW + o.boxW) / 2 + 2 &&
          Math.abs(L.sy - o.sy) < (L.boxH + o.boxH) / 2 + 2) return true;
    }
    return false;
  }

  var ICONS = { arrive: '\u2693', loop: '\u25D4', stack: '\u25A6', yield: '\u25D0', bridge: '\u2709',
    inbox: '\u2709', unpack: '\u25A3', pack: '\u25A8', work: '\u2699', work2: '\u2699', dom: '\u2767', style: '\u2699', layout: '\u229E', composite: '\u2726' };

  function drawPlate(L) {
    ctx.strokeStyle = Iso.rgba(L.edge || '#6e6250', 0.6);
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(L.ax, L.sy + L.boxH / 2); ctx.lineTo(L.ax, L.ay); ctx.stroke();
    ctx.fillStyle = Iso.rgba(L.edge || '#6e6250', 0.85);
    ctx.beginPath(); ctx.arc(L.ax, L.ay, 2.4, 0, 6.2832); ctx.fill();
    paintedPlate(L.ax, L.sy - L.dims.d / 2, L);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* What a district's plate says once the cart has paid for it. */
  function chargedFor(id) {
    var c = Sim.state.charged;
    if (!c) return null;
    switch (id) {
      case 'bridge':
        if (c.post == null) return null;
        return '+' + Model.fmtMs(c.post) + (c.reply != null ? ' / +' + Model.fmtMs(c.reply) : '');
      case 'yield':
        return Sim.state.tripMode === 'chunked' && c.stack != null ? '+' + Model.fmtMs(c.stack) : null;
      case 'stack':
        return Sim.state.tripMode !== 'chunked' && c.stack != null ? '+' + Model.fmtMs(c.stack) : null;
      case 'work2':
        return null;
      default:
        return c[id] != null ? '+' + Model.fmtMs(c[id]) : null;
    }
  }

  /* Small live chips under the name plates painted into the art: what the
     cart paid there on this trip, or the place's tagline while it is the
     subject of the panel. */
  /* Under each place's plate (painted, or ours for the two added places) a
     chip of the same height: what this trip paid there, or its tag. */
  /* The worker's sub-stops get a smaller, lighter tag than the painted
     plates, with a leader to the spot it names: name on top, charge below. */
  function drawTag(d, x, y, isActive, charge) {
    var f = Math.max(8, plateFont() * 0.7), u = ART.K * cam.scale;
    var spot = World.toScreen(d.spotArt[0], d.spotArt[1]);
    var sx = spot.x * cam.scale + cam.ox, sy = spot.y * cam.scale + cam.oy;
    ctx.font = (isActive ? '600 ' : '500 ') + f + 'px ' + SANS;
    var name = (ICONS[d.id] ? ICONS[d.id] + ' ' : '') + d.name;
    var w1 = ctx.measureText(name).width * SQ;
    ctx.font = '600 ' + (f * 0.92) + 'px ' + SANS;
    var w2 = charge ? ctx.measureText(charge).width * SQ : 0;
    var w = Math.max(w1, w2) + f * 1.3, h = charge ? f * 2.55 : f * 1.55;
    /* leader */
    ctx.strokeStyle = d.color; ctx.globalAlpha = 0.7; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(sx, sy); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = d.color;
    ctx.beginPath(); ctx.arc(sx, sy, 2.2, 0, 6.2832); ctx.fill();
    /* tag */
    ctx.fillStyle = 'rgba(50,62,56,0.16)';
    roundRect(x - w / 2 + 1, y - h / 2 + 2, w, h, h * 0.3); ctx.fill();
    ctx.fillStyle = isActive ? '#fffdf6' : 'rgba(253,250,242,0.93)';
    ctx.strokeStyle = d.color; ctx.lineWidth = isActive ? 1.6 : 0.9;
    roundRect(x - w / 2, y - h / 2, w, h, h * 0.3); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = isActive ? d.color : '#4a4238';
    ctx.font = (isActive ? '600 ' : '500 ') + f + 'px ' + SANS;
    var ty = charge ? y - f * 0.5 : y + f * 0.05;
    squeezed(name, x, ty);
    if (charge) {
      ctx.fillStyle = d.color;
      ctx.font = '600 ' + (f * 0.92) + 'px ' + SANS;
      squeezed(charge, x, y + f * 0.6);
    }
    obstacle(x, y, w, h);
  }

  function drawChips(activeId, hoverId) {
    ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
    var s = Sim.state, f = plateFont(), u = ART.K * cam.scale;
    World.districts.forEach(function (d) {
      if (!d.label) return;
      if (d.id === 'work2' && s.workers < 2) return;
      var isActive = d.id === activeId || d.id === hoverId;
      var p = World.toScreen(d.label[0], d.label[1]);
      var x = p.x * cam.scale + cam.ox, y = p.y * cam.scale + cam.oy;
      var bottom = y + 18 * u;                       /* painted plate: 30 face + 5 base, halved, about */
      var m = null;
      if (d.added === 'tag') { drawTag(d, x, y, isActive, chargedFor(d.id)); return; }
      if (!d.added) obstacle(x, y, 125 * u, 38 * u);
      if (d.added) {
        m = paintedPlate(x, y, { font: f, text: d.name, icon: ICONS[d.id],
          color: isActive ? d.color : null, edge: isActive ? d.color : null, strong: isActive, bold: isActive });
        bottom = y + m.h / 2 + m.d;
        obstacle(x, y, m.w, m.h + m.d);
      }
      var text = chargedFor(d.id) || (isActive ? d.tag : null);
      if (!text) return;
      var o = { font: f, text: text, bold: isActive,
        color: isActive ? d.color : '#4a4238', edge: d.color, strong: isActive };
      o.dims = plateDims(o);
      o.dims.h = f * 2.1; o.dims.d = o.dims.h * 0.15;
      var cx = x, cy = bottom + 3 + o.dims.h / 2;
      if (m && d.added !== 'below') { cx = x + d.added * (m.w / 2 + 4 + o.dims.w / 2); cy = y; }
      paintedPlate(cx, cy, o);
      obstacle(cx, cy, o.dims.w, o.dims.h + o.dims.d);
    });
  }

  /* ---------------------------------------------------------------- draw  */

  function draw(canvas, camera, time, activeDistrict, hoverDistrict) {
    ctx = canvas.getContext('2d');
    cam = camera;
    t = time;
    labels.length = 0;
    obstacles.length = 0;
    sample();

    var w = canvas.width / cam.dpr, h = canvas.height / cam.dpr;
    drawBackdrop(w, h);

    if (hoverDistrict && hoverDistrict !== activeDistrict) drawHighlight(hoverDistrict, false);
    if (activeDistrict) drawHighlight(activeDistrict, true);

    drawPipeline();
    drawMills();
    drawNoDomSign();
    drawWorkerSteps();
    drawClockHands();
    worldTransform();

    /* ---- one sorted pass over everything with a footprint ---- */
    var items = [];
    var i, s = Sim.state;

    for (i = 0; i < World.buildings.length; i++) {
      var b = World.buildings[i];
      items.push({ k: b.x + b.y, f: b.kind === 'signal' ? drawSignal : drawStackYard, a: b });
    }
    OCCLUDERS.forEach(function (o) { items.push({ k: o.k, f: drawOccluder, a: o }); });
    if (s.pileKB > 0) items.push({ k: World.clonePile[0] + World.clonePile[1], f: drawClonePile, a: World.clonePile });
    var env = envelopePos();
    if (env) items.push({ k: env.x + env.y + 0.2, f: drawEnvelope, a: env });
    var v = Sim.vanPosition();
    items.push({ k: v.x + v.y + 0.1, f: drawVan, a: v });

    items.sort(function (p, q) { return p.k - q.k; });
    for (i = 0; i < items.length; i++) items[i].f(items[i].a);

    worldTransform();

    if (showLabels) {
      drawChips(activeDistrict, hoverDistrict);
    }

    /* the cart's own plate: time since the click, and whether the main
       thread is free at that moment */
    if (s.running && !s.finished) {
      var m = now.busy && now.busy.main;
      var st = !m ? 'main thread free'
             : m.kind === 'render' ? 'main: painting a frame'
             : 'main thread busy';
      labels.push({
        x: v.x, y: v.y, z: (v.z || 0) + 1.3, lift: 8, scale: 0.95,
        text: Model.fmtMs(Math.max(0, now.tau - s.plan.click)) + ' since click',
        sub: st + (s.cargoKB ? ' · ' + Model.fmtKB(s.cargoKB) : ''),
        subColor: m && m.kind !== 'render' ? '#b8503f' : '#4f8a58',
        color: '#2f2a24', edge: MODE_COLOR[s.tripMode], bold: true,
        pri: 3
      });
    }

    drawLabels();
  }

  global.Renderer = {
    draw: draw,
    setLabels: function (v) { showLabels = v; }
  };
})(window);
