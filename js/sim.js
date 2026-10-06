/* sim.js: the state machine that walks one click through the island.
 *
 * This is the pacing engine from the template, with the island's branches
 * added. Three ideas do all the work:
 *
 *   1. The cart moves along a route by distance, and a station fires when it
 *      passes one. Stations own the model steps; travel owns nothing.
 *   2. The FIRST time a topic is shown, the cart stops for as long as its
 *      write-up takes to read. Every later visit gets a short beat instead.
 *   3. What the reader has already read (`tour`) lives outside the run state,
 *      so a reset replays the run but not the reading.
 *
 * One click is one trip. By default three trips run, each doing the same job
 * a different way: on the main thread, in chunks, then in a Web Worker.
 */
(function (global) {
  'use strict';

  var Model = global.Model;
  var World = global.World;
  var Iso = global.Iso;

  var BASE_SPEED = 6;        // grid units / second at 1x
  var AUTO_MODES = ['main', 'chunked', 'worker'];
  var CHUNK_LAPS = 3;        // laps of the ring that stand for the slices

  /* Which topics the reader has already had explained. This deliberately
     survives a reset, because nobody wants to re-read the tour. */
  var tour = { seen: Object.create(null), done: false };

  var state = {
    running: false,
    paused: true,
    finished: false,

    station: null,
    topic: null,
    stationT: 0,
    stepMode: false,
    speed: 1,

    /* ---- model inputs, wired to the controls in ui.js ---- */
    mode: 'auto',            // 'auto' runs main → chunked → worker
    workMs: 480,
    chunkMs: 8,
    workers: 1,
    dataKB: 8192,
    transfer: false,
    nodes: 400,

    /* ---- what the island has learned as it runs ---- */
    workerWarm: false,       // the worker stays alive after its first job

    /* ---- this trip ---- */
    trip: 0,                 // 0-based index of the trip on the road
    maxTrips: 3,
    tripMode: 'main',
    plan: null,              // the whole timeline for the current trip
    charged: null,           // station id -> ms actually charged this trip
    elapsedMs: 0,            // what the cart is carrying: ms since the click
    lastCharge: 0,           // the charge being animated during this stop
    cargoKB: 0,              // pixels aboard
    pileKB: 0,               // the copy a structured clone left behind
    lapsLeft: 0,
    dispatched: false,       // has the job gone over the bridge this trip?
    gaugeMs: 0,              // longest main-thread task during this step
    results: {},             // mode -> finished plan, for the comparison

    /* ---- pacing ---- */
    reading: false,
    dwellLeft: 0,
    dwellTotal: 0,
    fastForward: false,
    tourDone: false
  };

  var van = {
    routeName: 'arrive',
    dist: 0,
    dwell: 0,
    stationIdx: 0
  };

  var listeners = [];
  function emit(name, payload) {
    for (var i = 0; i < listeners.length; i++) listeners[i](name, payload);
  }

  /* ---- the model ---------------------------------------------------------- */

  function inputs(mode) {
    return {
      mode: mode,
      workMs: state.workMs,
      chunkMs: state.chunkMs,
      workers: state.workers,
      dataKB: state.dataKB,
      transfer: state.transfer,
      nodes: state.nodes,
      workerWarm: mode === 'worker' && state.workerWarm
    };
  }

  /* Recomputed whenever it is needed rather than cached, so dragging a slider
     mid-trip changes the steps that have not been charged yet. Steps already
     paid for keep the number they were charged. */
  function planNow() { return Model.simulate(inputs(state.tripMode)); }

  /* What the model says about a mode right now, for the comparison card. */
  function planFor(mode, warm) {
    var p = inputs(mode);
    if (warm != null) p.workerWarm = warm;
    return Model.simulate(p);
  }

  /* Display clock in model time: the click, plus everything charged, minus
     the part of the current stop's charge still to animate. Timelines and the
     spinner read this, so they move while the cart is stopped. */
  function tau() {
    if (!state.plan) return 0;
    var left = state.dwellTotal > 0 ? state.dwellLeft / state.dwellTotal : 0;
    return state.plan.click + state.elapsedMs - state.lastCharge * left;
  }

  function charge(id, ms) {
    state.plan = planNow();
    if (ms == null) ms = state.plan.charges[id] || 0;
    var t0 = state.plan.click + state.elapsedMs;
    state.charged[id] = (state.charged[id] || 0) + ms;
    state.elapsedMs += ms;
    state.lastCharge = ms;
    state.gaugeMs = Model.longestIn(state.plan, t0, t0 + Math.max(ms, 0.01));
    return ms;
  }

  /* ---- lifecycle --------------------------------------------------------- */

  function modeForTrip(i) {
    return state.mode === 'auto' ? AUTO_MODES[i % 3] : state.mode;
  }

  function beginTrip() {
    state.charged = Object.create(null);
    state.elapsedMs = 0;
    state.lastCharge = 0;
    state.cargoKB = 0;
    state.pileKB = 0;
    state.gaugeMs = 0;
    state.lapsLeft = 0;
    state.dispatched = false;
    state.station = null;
    state.topic = null;
    state.tripMode = modeForTrip(state.trip);
    state.plan = planNow();
    state.fastForward = state.trip > 0 && state.tripMode === modeForTrip(state.trip - 1);
    van.routeName = 'arrive';
    van.dist = 0;
    van.stationIdx = 0;
    van.dwell = 0;
  }

  function reset() {
    state.finished = false;
    state.trip = 0;
    state.maxTrips = state.mode === 'auto' ? 3 : 2;
    state.workerWarm = false;
    state.results = {};
    state.tourDone = tour.done;
    state.reading = false;
    state.dwellLeft = 0;
    state.dwellTotal = 0;
    beginTrip();
  }

  function run() {
    reset();
    state.running = true;
    state.paused = false;
    emit('reset');
  }

  /* ---- per-station work -------------------------------------------------- */

  var OPS = {
    arrive: function () {
      charge('arrive');
      /* the click carries the image the handler has to process */
      state.cargoKB = state.dataKB;
    },

    loop: function () {
      /* Later laps of a chunked run pass the gate again, but the handler only
         ran once; the slices are charged at the yard. */
      if (state.charged.loop != null) { state.lastCharge = 0; state.gaugeMs = 0; return; }
      charge('loop');
      if (state.tripMode === 'chunked') state.lapsLeft = CHUNK_LAPS;
    },

    stack: function () {
      if (state.tripMode === 'chunked') {
        /* Each lap stands for a third of the slices and the frames between
           them; the three charges add up to the model's stack time exactly. */
        charge('stack', state.plan.charges.stack / CHUNK_LAPS);
        state.lapsLeft--;
      } else {
        charge('stack');
      }
    },

    post: function () {
      charge('post');
      state.dispatched = true;
      /* A structured clone leaves the page's copy behind; a transfer does not,
         the buffer is detached and the page cannot read it any more. */
      state.pileKB = state.transfer ? 0 : state.dataKB;
    },

    /* the worker's own stops: its inbox, unpacking, the job, packing */
    inbox: function () { charge('inbox'); },
    unpack: function () { charge('unpack'); },
    work: function () { charge('work'); },
    pack: function () { charge('pack'); },

    reply: function () {
      charge('reply');
      /* the processed image, the same size as what went out */
      state.cargoKB = state.dataKB;
      state.workerWarm = true;
    },

    dom: function () {
      charge('dom');
      /* the pixels are in the page now */
      state.cargoKB = 0;
    },

    style: function () { charge('style'); },
    layout: function () { charge('layout'); },

    composite: function () {
      charge('composite');
      state.results[state.tripMode] = state.plan;
      state.trip++;
      emit('trip', state.trip);
    }
  };

  /* Stations that do not apply to this trip are driven past without a stop:
     with a worker the main thread never sits in the call-stack yard. */
  function skips(id) {
    return id === 'stack' && state.tripMode === 'worker';
  }

  /* ---- update ------------------------------------------------------------ */

  function routeOf(name) { return World.routes[name]; }

  /* Once every topic has been explained there is nothing left to read, so the
     remaining trips run at a watchable pace instead of a readable one. */
  function travelBoost() {
    return (state.fastForward ? 2.4 : 1) * (state.tourDone ? 3.0 : 1);
  }
  function dwellBoost() {
    /* Stops stay generous even after the tour, because their numbers change. */
    return (state.fastForward ? 2.2 : 1) * (state.tourDone ? 1.4 : 1);
  }

  function fire(st) {
    state.station = st.id;
    state.stationT = 0;
    var op = OPS[st.id];
    if (op) op();
    emit('station', st.id);
  }

  function go(name, dwell) {
    van.routeName = name;
    van.dist = 0;
    van.stationIdx = 0;
    van.dwell = dwell || 0.25;
  }

  function checkTourDone() {
    var all = World.tourTopics.every(function (k) { return tour.seen[k]; });
    if (all) { tour.done = true; state.tourDone = true; }
  }

  function advanceRoute() {
    var r = van.routeName;
    if (r === 'arrive') {
      go('ringA');
    } else if (r === 'ringA') {
      /* The branch that is the whole point: with a worker, the job leaves the
         main island instead of going round the loop. */
      if (state.tripMode === 'worker' && !state.dispatched) go('worker', 0.3);
      else go('ringB');
    } else if (r === 'worker') {
      go('ringB');
    } else if (r === 'ringB') {
      if (state.tripMode === 'chunked' && state.lapsLeft > 0) go('ringA');
      else go('render', 0.3);
    } else if (r === 'render') {
      checkTourDone();
      if (state.trip >= state.maxTrips) {
        state.finished = true;
        state.paused = true;
        state.station = 'done';
        state.topic = null;
        emit('station', 'done');
        return;
      }
      beginTrip();
      emit('trip-start', state.trip);
    }
  }

  function update(dt) {
    state.stationT += dt;
    if (!state.running || state.paused || state.finished) return;

    var sdt = dt * state.speed * travelBoost();

    if (van.dwell > 0) {
      /* A stop is measured in reading seconds, so only the speed slider scales
         it; the travel boosts must never cut a first read short. */
      van.dwell -= dt * state.speed;
      state.dwellLeft = Math.max(0, van.dwell);
      if (van.dwell <= 0) { state.reading = false; state.dwellTotal = 0; state.lastCharge = 0; }
      return;
    }

    var route = routeOf(van.routeName);
    van.dist += BASE_SPEED * sdt;

    var sts = World.stations[van.routeName];
    while (van.stationIdx < sts.length && skips(sts[van.stationIdx].id)) van.stationIdx++;
    if (van.stationIdx < sts.length) {
      var st = sts[van.stationIdx];
      if (van.dist >= st.dist) {
        van.dist = st.dist;
        van.stationIdx++;
        /* Keyed by topic, not by station: two stations that show the same
           write-up must not charge the reader for a second read. */
        var topic = World.topicOf(st.id, state);
        state.topic = topic;
        var firstTime = !tour.seen[topic];
        fire(st);
        tour.seen[topic] = true;
        van.dwell = firstTime ? World.readSeconds(topic) : st.dwell / dwellBoost();
        state.reading = firstTime;
        state.dwellTotal = van.dwell;
        state.dwellLeft = van.dwell;
        if (state.stepMode) { state.paused = true; state.stepMode = false; }
        return;
      }
    }

    if (van.dist >= route.total) advanceRoute();
  }

  /* ---- queries used by the renderer and the camera ----------------------- */

  function vanPosition() {
    return Iso.smoothAt(routeOf(van.routeName), van.dist, 0.8);
  }

  global.Sim = {
    state: state,
    van: van,
    run: run,
    reset: function () { reset(); emit('reset'); },
    /* forget which topics have been explained, so the slow tour replays */
    replayTour: function () { tour.seen = Object.create(null); tour.done = false; },
    update: update,
    vanPosition: vanPosition,
    planNow: planNow,
    planFor: planFor,
    tau: tau,
    on: function (fn) { listeners.push(fn); },
    play: function () { if (!state.finished) { state.paused = false; state.running = true; } },
    pause: function () { state.paused = true; },
    toggle: function () { if (state.paused) this.play(); else this.pause(); },
    step: function () {
      if (state.finished) return;
      state.running = true;
      state.stepMode = true;
      state.paused = false;
      if (van.dwell > 0) {
        van.dwell = 0;
        state.dwellLeft = 0; state.dwellTotal = 0; state.reading = false; state.lastCharge = 0;
      }
    }
  };
})(window);
