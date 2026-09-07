// The display.
//
// It imports the same projection maths the tests run against — served with its
// types stripped, not reimplemented here — so what you see on screen is what is
// covered by the suite.
//
// The whole loop is: fetch a snapshot every few seconds, and between snapshots
// advance every target by dead reckoning using *monotonic* elapsed time. Never
// `Date.now()`: the ages on screen are relative to OpenSky's clock, and a
// viewer whose laptop is ten minutes out must still see the truth.

import { project, isDisplayable } from '/core/target.js';
import { STOCKHOLM as BOX } from '/core/box.js';

const REFRESH_MS = 8000;

const el = {
  canvas: document.getElementById('scope'),
  status: document.getElementById('status'),
  count: document.getElementById('count'),
  oldest: document.getElementById('oldest'),
  snapshotAge: document.getElementById('snapshot-age'),
  budget: document.getElementById('budget'),
  tooltip: document.getElementById('tooltip'),
  tableBody: document.getElementById('table-body'),
  liveStatus: document.getElementById('live-status'),
};

const ctx = el.canvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

/** Everything the display knows. `snapshot` survives a failed fetch on purpose. */
const state = {
  snapshot: null,
  /** performance.now() at the moment the snapshot arrived — monotonic, unlike the wall clock. */
  receivedAt: 0,
  status: 'connecting',
  budget: null,
  drawn: [],
  pointer: null,
};

/* -------------------------------------------------------------- projection */

/** Equirectangular, with longitude squeezed by the latitude of the box centre. */
function makeProjection(width, height) {
  const midLat = (BOX.lamin + BOX.lamax) / 2;
  const lonScale = Math.cos((midLat * Math.PI) / 180);

  const spanLat = BOX.lamax - BOX.lamin;
  const spanLon = (BOX.lomax - BOX.lomin) * lonScale;

  const pad = 0.06;
  const scale = Math.min(width * (1 - pad) / spanLon, height * (1 - pad) / spanLat);

  const offsetX = (width - spanLon * scale) / 2;
  const offsetY = (height - spanLat * scale) / 2;

  return ({ lat, lon }) => ({
    x: offsetX + (lon - BOX.lomin) * lonScale * scale,
    // Screen y grows downward, latitude grows upward.
    y: offsetY + (BOX.lamax - lat) * scale,
  });
}

let toScreen = makeProjection(1, 1);

/** CSS pixel size of the canvas itself — no longer the whole viewport. */
const scopeSize = () => ({
  w: el.canvas.clientWidth || 1,
  h: el.canvas.clientHeight || 1,
});

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const { w, h } = scopeSize();
  el.canvas.width = Math.round(w * dpr);
  el.canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  toScreen = makeProjection(w, h);
}

/* ----------------------------------------------------------------- drawing */

/** Screen positions of labels already drawn this frame, to avoid a pile-up. */
let labelSlots = [];

const COLOURS = {
  coast: '#2b3d49',
  lake: '#213039',
  live: '#e6edf2',
  aging: '#8d9aa5',
  stale: '#5c6871',
  frozen: '#e0a066',
  mlat: '#7fb0c8',
  grid: '#1d242a',
};

function drawGrid(w, h) {
  ctx.save();
  ctx.strokeStyle = COLOURS.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 6]);

  for (let lat = Math.ceil(BOX.lamin * 2) / 2; lat <= BOX.lamax; lat += 0.5) {
    const { y } = toScreen({ lat, lon: BOX.lomin });
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  for (let lon = Math.ceil(BOX.lomin); lon <= BOX.lomax; lon += 1) {
    const { x } = toScreen({ lat: BOX.lamin, lon });
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  ctx.restore();
}

/**
 * Coastline and lakes, traced once from OpenStreetMap and frozen into a file.
 *
 * No tile server, no map library, no API key, nothing fetched from a third
 * party at runtime: the geography is 171 KB of line strings that ship with the
 * app. It was 1.8 million points as downloaded; anything finer than half a
 * pixel at this scale is invisible, so it is simplified down to under 10,000.
 */
let geography = null;

fetch('/data/geography.json')
  .then(r => r.json())
  .then(data => { geography = data; })
  .catch(error => console.warn('geography unavailable, scope stays empty:', error));

function drawGeography() {
  if (!geography) return;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1;

  for (const [key, colour] of [['lakes', COLOURS.lake], ['coast', COLOURS.coast]]) {
    ctx.strokeStyle = colour;
    ctx.beginPath();
    for (const line of geography[key] ?? []) {
      let first = true;
      for (const [lon, lat] of line) {
        const { x, y } = toScreen({ lat, lon });
        if (first) { ctx.moveTo(x, y); first = false; } else { ctx.lineTo(x, y); }
      }
    }
    // One stroke for every line of a layer: 1,400 separate strokes would cost
    // far more than a single path with 1,400 subpaths.
    ctx.stroke();
  }
  ctx.restore();
}

/** Airports, so the picture is anchored to something recognisable. */
const AIRPORTS = [
  { name: 'ESSA Arlanda', lat: 59.6519, lon: 17.9186 },
  { name: 'ESSB Bromma', lat: 59.3544, lon: 17.9416 },
  { name: 'ESSL Skavsta', lat: 58.7886, lon: 16.9122 },
];

function drawAirports() {
  ctx.save();
  ctx.strokeStyle = COLOURS.stale;
  ctx.fillStyle = COLOURS.stale;
  ctx.font = '10px ui-monospace, Menlo, monospace';

  for (const airport of AIRPORTS) {
    if (airport.lat < BOX.lamin || airport.lat > BOX.lamax) continue;
    const { x, y } = toScreen(airport);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.stroke();
    // Airports claim their label slot first: they are the fixed reference the
    // rest of the picture is read against, so a passing aircraft must not
    // cover Arlanda's name.
    if (claimLabelSlot(x, y)) ctx.fillText(airport.name, x + 8, y + 3);
  }
  ctx.restore();
}

/**
 * Around Arlanda a dozen targets sit within a few pixels of each other and
 * every label lands on top of the last, which is worse than no label at all.
 * The first target to claim a patch of screen keeps it; the rest go unlabelled
 * and stay readable through the tooltip.
 */
function claimLabelSlot(x, y) {
  for (const slot of labelSlots) {
    if (Math.abs(slot.x - x) < 58 && Math.abs(slot.y - y) < 13) return false;
  }
  labelSlots.push({ x, y });
  return true;
}

function drawTarget(target, projection) {
  const { x, y } = toScreen(projection.position);
  const colour = COLOURS[projection.freshness] ?? COLOURS.stale;

  ctx.save();
  ctx.translate(x, y);

  if (target.onGround) {
    // A square, not a chevron: it has a position but no meaningful heading to
    // point at, and pretending otherwise is the kind of small lie this display
    // is built to avoid.
    ctx.fillStyle = colour;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(-3.5, -3.5, 7, 7);
  } else {
    ctx.rotate(((target.track ?? 0) * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();

    if (projection.freshness === 'stale') {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.fillStyle = colour;
      ctx.fill();
    }
    ctx.rotate(-((target.track ?? 0) * Math.PI) / 180);
  }

  // A frozen target has outrun its own data: the ring says the symbol is
  // parked, not flying.
  if (projection.frozen) {
    ctx.strokeStyle = COLOURS.frozen;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Multilaterated positions are drawn inside a circle of uncertainty rather
  // than as a point, because that is what they are.
  if (target.source === 'mlat') {
    ctx.strokeStyle = COLOURS.mlat;
    ctx.lineWidth = 1;
    ctx.setLineDash([1, 3]);
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (target.callsign && projection.freshness !== 'stale' && claimLabelSlot(x, y)) {
    ctx.fillStyle = colour;
    ctx.globalAlpha = 0.75;
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillText(target.callsign, 10, -2);
    if (target.altitude !== null && !target.onGround) {
      ctx.fillStyle = COLOURS.stale;
      ctx.fillText(flightLevel(target.altitude), 10, 9);
    }
  }

  ctx.restore();
}

const flightLevel = (metres) => `FL${String(Math.round((metres * 3.28084) / 100)).padStart(3, '0')}`;

function render() {
  const { w, h } = scopeSize();

  ctx.clearRect(0, 0, w, h);
  labelSlots = [];
  drawGeography();
  drawGrid(w, h);
  drawAirports();

  if (!state.snapshot) return;

  // Monotonic: immune to the viewer's clock, and to it being adjusted mid-session.
  const elapsed = (performance.now() - state.receivedAt) / 1000;

  state.drawn = [];
  for (const target of state.snapshot.targets) {
    const projection = project(target, elapsed);
    if (!isDisplayable(projection)) continue;
    drawTarget(target, projection);
    state.drawn.push({ target, projection, screen: toScreen(projection.position) });
  }

  updateReadout(elapsed);
  drawTooltip();
}

/* ---------------------------------------------------------------- readouts */

const formatAge = (seconds) => {
  const s = Math.round(seconds);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, '0')} s`;
};

function updateReadout(elapsed) {
  const drawn = state.drawn;
  const airborne = drawn.filter(d => !d.target.onGround).length;

  el.count.textContent = `${drawn.length} (${airborne} airborne)`;
  el.snapshotAge.textContent = formatAge(elapsed);

  const oldest = drawn.reduce((max, d) => Math.max(max, d.projection.age), 0);
  el.oldest.textContent = drawn.length ? formatAge(oldest) : '—';
  // The oldest contact is the number that matters most, so it is coloured when
  // it stops being reassuring.
  el.oldest.style.color = oldest > 60 ? 'var(--warn)' : '';

  el.budget.textContent = state.budget === null ? 'n/a' : `${state.budget} credits`;
}

function setStatus(status) {
  if (state.status === status) return;
  state.status = status;
  el.status.textContent = status;
  el.status.className = `pill pill--${status === 'degraded' ? 'degraded' : status === 'mock' ? 'mock' : 'live'}`;
  const contacts = state.snapshot?.targets.length ?? 0;
  el.liveStatus.textContent =
    status === 'degraded'
      ? 'Connection lost. Showing the last known positions, which are ageing.'
      : status === 'mock'
        // The screen reader should not be told this is live when it is a replay.
        ? `Replaying a recorded snapshot. ${contacts} contacts.`
        : `Live. ${contacts} contacts.`;
}

function updateTable() {
  if (!state.snapshot) return;
  el.tableBody.replaceChildren(...state.drawn.map(({ target, projection }) => {
    const row = document.createElement('tr');
    for (const value of [
      target.callsign ?? target.icao24,
      target.onGround ? 'on the ground' : target.altitude === null ? 'unknown' : `${Math.round(target.altitude)} m`,
      target.velocity === null ? 'unknown' : `${Math.round(target.velocity)} m/s`,
      target.track === null ? 'unknown' : `${Math.round(target.track)}°`,
      `${formatAge(projection.age)}${projection.frozen ? ', position frozen' : ''}`,
      target.source,
    ]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
}

/* ---------------------------------------------------------------- tooltip */

function drawTooltip() {
  const pointer = state.pointer;
  if (!pointer) { el.tooltip.hidden = true; return; }

  let nearest = null;
  let bestDistance = 18;
  for (const item of state.drawn) {
    const distance = Math.hypot(item.screen.x - pointer.x, item.screen.y - pointer.y);
    if (distance < bestDistance) { bestDistance = distance; nearest = item; }
  }

  if (!nearest) { el.tooltip.hidden = true; return; }

  const { target, projection } = nearest;
  el.tooltip.textContent = [
    `${target.callsign ?? '(no callsign)'}  ${target.icao24}`,
    `${target.originCountry}`,
    ``,
    `altitude   ${target.onGround ? 'on the ground' : target.altitude === null ? 'unknown' : `${Math.round(target.altitude)} m`}`,
    `speed      ${target.velocity === null ? 'unknown' : `${Math.round(target.velocity)} m/s`}`,
    `track      ${target.track === null ? 'unknown' : `${Math.round(target.track)}°`}`,
    `source     ${target.source.toUpperCase()}`,
    `fix age    ${formatAge(projection.age)}`,
    `position   ${projection.frozen ? 'frozen — too old to extrapolate'
      : projection.estimated ? 'estimated by dead reckoning' : 'as reported'}`,
  ].join('\n');

  el.tooltip.hidden = false;
  const box = el.tooltip.getBoundingClientRect();
  el.tooltip.style.left = `${Math.min(pointer.viewportX + 16, innerWidth - box.width - 8)}px`;
  el.tooltip.style.top = `${Math.min(pointer.viewportY + 16, innerHeight - box.height - 8)}px`;
}

/* ------------------------------------------------------------------- fetch */

async function refresh() {
  try {
    const response = await fetch('/api/states', { cache: 'no-store' });
    if (!response.ok) throw new Error(`endpoint returned ${response.status}`);

    const snapshot = await response.json();
    state.snapshot = snapshot;
    state.receivedAt = performance.now();
    state.budget = snapshot.budget?.remaining ?? null;
    setStatus(snapshot.mock ? 'mock' : 'live');
    updateTable();
  } catch (error) {
    // The previous snapshot is deliberately kept. It keeps ageing on screen,
    // which is the honest thing to show — an empty display would suggest an
    // empty sky, and a frozen one would suggest nothing had changed.
    console.warn('refresh failed:', error);
    setStatus('degraded');
  }
}

/* -------------------------------------------------------------------- boot */

addEventListener('resize', () => { resize(); if (reducedMotion.matches) render(); });
// Hit-testing happens in canvas coordinates; the tooltip is positioned in
// viewport coordinates. Keeping both avoids an offset bug the moment the
// canvas stops starting at 0,0.
el.canvas.addEventListener('pointermove', (event) => {
  const box = el.canvas.getBoundingClientRect();
  state.pointer = {
    x: event.clientX - box.left,
    y: event.clientY - box.top,
    viewportX: event.clientX,
    viewportY: event.clientY,
  };
});
el.canvas.addEventListener('pointerleave', () => { state.pointer = null; });

resize();
await refresh();
setInterval(refresh, REFRESH_MS);

if (reducedMotion.matches) {
  // No animation: positions update once per snapshot. The ages still advance,
  // so the display stays honest without anything moving.
  render();
  setInterval(render, 1000);
} else {
  const frame = () => { render(); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
}
