import {
  summarize, recommend, baseline, fmtTime, monthLabel, CAUSE_KEYS, DOW, MIN_N, GRADES,
} from "./metrics.js";

const $ = (id) => document.getElementById(id);
const pct = (x, d = 1) => (x == null ? "–" : `${(x * 100).toFixed(d)}%`);
const num = (x) => (x == null ? "–" : x.toLocaleString("en-US"));
const mins = (x) => (x == null ? "–" : `${Math.round(x)} min`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let META, BASE, ROUTE = null;
const routeCache = new Map();
const pairs = new Map();       // airport -> Map(otherAirport -> {n, carriers})
const state = { a: "", b: "", carrier: "", mi0: 0, mi1: 0, dir: "both", flightSort: "best", showAllFlights: false };

/* ---------- boot ---------- */
async function boot() {
  try {
    [META, BASE] = await Promise.all([
      fetch("data/meta.json").then((r) => r.json()),
      fetch("data/baselines.json").then((r) => r.json()),
    ]);
  } catch (e) {
    $("status").textContent = "Couldn’t load flight data. Try refreshing.";
    return;
  }
  for (const [a, b, n, cs] of META.routes) {
    if (!pairs.has(a)) pairs.set(a, new Map());
    if (!pairs.has(b)) pairs.set(b, new Map());
    pairs.get(a).set(b, { n, cs });
    pairs.get(b).set(a, { n, cs });
  }
  const last = META.months.length - 1;
  state.mi1 = last;
  state.mi0 = Math.max(0, last - 11);
  fillMonths();
  fillAirportA();
  $("dataNote").textContent = `Data covers ${monthLabel(META.months[0])} – ${monthLabel(META.months[last])}: ${num(META.flights)} flights. Updated ${META.generated.slice(0, 10)}.`;

  readHash();
  if (!state.a || !pairs.get(state.a)?.has(state.b)) {
    const def = pairs.get("DFW")?.has("GSO") ? ["DFW", "GSO"] : busiest();
    [state.a, state.b] = def;
  }
  wire();
  await load();
}

function busiest() {
  const r = META.routes.reduce((x, y) => (y[2] > x[2] ? y : x));
  return [r[0], r[1]];
}

/* ---------- controls ---------- */
const apLabel = (code) => {
  const city = META.airports[code] || "";
  return city ? `${code} · ${city}` : code;
};

function fillAirportA() {
  const codes = [...pairs.keys()].sort();
  $("apA").innerHTML = codes.map((c) => `<option value="${c}">${esc(apLabel(c))}</option>`).join("");
}

function fillAirportB() {
  const others = [...(pairs.get(state.a)?.keys() || [])].sort();
  $("apB").innerHTML = others.map((c) => `<option value="${c}">${esc(apLabel(c))}</option>`).join("");
  if (!others.includes(state.b)) state.b = others[0] || "";
  $("apB").value = state.b;
}

function fillCarrier() {
  const info = pairs.get(state.a)?.get(state.b);
  const cs = info ? info.cs : [];
  if (state.carrier && !cs.includes(state.carrier)) state.carrier = "";
  $("carrier").innerHTML = `<option value="">All airlines</option>` +
    cs.map((c) => `<option value="${c}">${esc(META.carriers[c] || c)} (${c})</option>`).join("");
  $("carrier").value = state.carrier;
}

function fillMonths() {
  const opts = META.months.map((m, i) => `<option value="${i}">${monthLabel(m)}</option>`).join("");
  $("mFrom").innerHTML = opts;
  $("mTo").innerHTML = opts;
}

function fillDir() {
  // In the data, dir 0 = flights departing the alphabetically-first airport. Map to the user's From/To order.
  const fromIsLo = state.a === lo();
  const segs = [["both", "Both ways"], [fromIsLo ? 0 : 1, `${state.a} → ${state.b}`], [fromIsLo ? 1 : 0, `${state.b} → ${state.a}`]];
  $("dirSeg").innerHTML = segs.map(([v, l]) =>
    `<button type="button" role="radio" data-v="${v}" aria-checked="${String(state.dir) === String(v)}">${l}</button>`).join("");
}

function syncControls() {
  $("apA").value = state.a;
  fillAirportB();
  fillCarrier();
  $("mFrom").value = state.mi0;
  $("mTo").value = state.mi1;
  fillDir();
  fillFlightSeg();
}

function wire() {
  $("apA").addEventListener("change", (e) => { state.a = e.target.value; state.dir = "both"; load(); });
  $("apB").addEventListener("change", (e) => { state.b = e.target.value; state.dir = "both"; load(); });
  $("swap").addEventListener("click", () => {
    [state.a, state.b] = [state.b, state.a];
    load();
  });
  $("carrier").addEventListener("change", (e) => { state.carrier = e.target.value; update(); });
  $("mFrom").addEventListener("change", (e) => {
    state.mi0 = +e.target.value; if (state.mi0 > state.mi1) state.mi1 = state.mi0; update();
  });
  $("mTo").addEventListener("change", (e) => {
    state.mi1 = +e.target.value; if (state.mi1 < state.mi0) state.mi0 = state.mi1; update();
  });
  $("dirSeg").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v; if (v == null) return;
    state.dir = v === "both" ? "both" : +v; update();
  });
  $("flightSeg").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v; if (!v) return;
    state.flightSort = v; state.showAllFlights = false; update();
  });
  window.addEventListener("hashchange", () => { if (readHash()) load(); });
  wireTooltip();
}

/* ---------- URL state (shareable links) ---------- */
function writeHash() {
  const p = new URLSearchParams();
  if (state.carrier) p.set("c", state.carrier);
  p.set("f", META.months[state.mi0]);
  p.set("t", META.months[state.mi1]);
  if (state.dir !== "both") p.set("d", state.dir === 0 ? `${lo()}` : `${hi()}`);
  const h = `#${state.a}-${state.b}?${p}`;
  if (location.hash !== h) history.replaceState(null, "", h);
}
const lo = () => [state.a, state.b].sort()[0];
const hi = () => [state.a, state.b].sort()[1];

function readHash() {
  const m = location.hash.match(/^#([A-Z0-9]{3})-([A-Z0-9]{3})(?:\?(.*))?$/);
  if (!m) return false;
  const before = JSON.stringify(state);
  state.a = m[1]; state.b = m[2];
  const p = new URLSearchParams(m[3] || "");
  state.carrier = p.get("c") || "";
  const f = META.months.indexOf(p.get("f")), t = META.months.indexOf(p.get("t"));
  if (f >= 0) state.mi0 = f;
  if (t >= 0) state.mi1 = Math.max(t, state.mi0);
  const d = p.get("d");
  state.dir = d ? (d === [state.a, state.b].sort()[0] ? 0 : 1) : "both";
  return JSON.stringify(state) !== before;
}

/* ---------- data ---------- */
async function load() {
  if (!state.a || !state.b) return;
  syncControls();
  const key = [state.a, state.b].sort().join("-");
  $("status").textContent = "Loading route…";
  try {
    if (!routeCache.has(key)) {
      const r = await fetch(`data/r/${key}.json`);
      if (!r.ok) throw new Error(r.status);
      routeCache.set(key, await r.json());
    }
    ROUTE = routeCache.get(key);
    $("status").textContent = "";
    update();
  } catch (e) {
    $("status").textContent = `No data for ${state.a} ↔ ${state.b}.`;
    $("results").hidden = true;
  }
}

function update() {
  if (!ROUTE) return;
  syncControls();
  writeHash();
  render();
}

/* ---------- render ---------- */
const dirLabel = (d) => (d === 0 ? `${ROUTE.a} → ${ROUTE.b}` : `${ROUTE.b} → ${ROUTE.a}`);

function render() {
  const sel = { carrier: state.carrier, mi0: state.mi0, mi1: state.mi1, dir: state.dir };
  const S = summarize(ROUTE, sel);
  const K = S.all;
  $("results").hidden = false;

  const title = state.dir === "both" ? `${state.a} ⇄ ${state.b}` : dirLabel(state.dir);
  $("routeTitle").textContent = title;
  const carrierTxt = state.carrier ? `${META.carriers[state.carrier] || state.carrier} only` : "All airlines";
  $("routeSub").textContent = `${carrierTxt} · ${state.mi0 === state.mi1 ? monthLabel(META.months[state.mi0]) : `${monthLabel(META.months[state.mi0])} – ${monthLabel(META.months[state.mi1])}`} · ${num(K.sched)} scheduled flights`;

  const nat = baseline(BASE.national, state.mi0, state.mi1);
  renderKpis(K, nat);
  $("recs").innerHTML = recommend(ROUTE, sel, META).map((r) => `<div class="rec"><b>${esc(r.title)}</b><p>${esc(r.body)}</p></div>`).join("");
  renderBaseline(K, nat);
  renderDirection(S);
  renderHours(S, K);
  renderCauses(K);
  renderFlights(S);
  renderMonths(S);
  renderDows(S, K);
}

function deltaHtml(v, ref, label) {
  if (v == null || ref == null) return "";
  const d = v - ref;
  const cls = Math.abs(d) < 0.005 ? "" : d > 0 ? "worse" : "better";
  const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
  return `<span class="delta ${cls}">${sign}${(Math.abs(d) * 100).toFixed(1)} pts</span> vs ${label}`;
}

function renderKpis(K, nat) {
  const thin = K.sched < MIN_N ? ` <span class="thin-chip">low sample</span>` : "";
  const tiles = [
    ["Arrive 15+ min late", pct(K.delayRate), `${deltaHtml(K.delayRate, nat.delayRate, "US avg")}<br>${num(K.delayed)} of ${num(K.flown)} flown${thin}`],
    ["Cancelled", pct(K.cancRate), `${deltaHtml(K.cancRate, nat.cancRate, "US avg")}<br>${num(K.canc)} of ${num(K.sched)} scheduled${thin}`],
    ["Avg delay when late", K.meanLate == null ? "–" : `${Math.round(K.meanLate)}<small> min</small>`, `Typical arrival: ${K.medianArr == null ? "–" : `${K.medianArr < 0 ? "≈" + Math.abs(Math.round(K.medianArr)) + " min early" : "≈" + Math.round(K.medianArr) + " min late"}`} (median)`],
    ["1 hour+ late", pct(K.sev60), `${pct(K.sev120)} were 2 hours+ late<br>${K.diverted ? `${num(K.diverted)} diverted` : "of flights flown"}`],
  ];
  $("kpis").innerHTML = tiles.map(([l, v, s]) => `<div class="kpi"><div class="lbl">${l}</div><div class="val">${v}</div><div class="sub">${s}</div></div>`).join("");
}

function hbars(rows, fmt = pct) {
  const max = Math.max(...rows.map((r) => r.v || 0), 0.0001);
  return rows.map((r) => `
    <div class="hb ${r.hl ? "hl" : ""}" data-tip="${esc(r.tip || "")}">
      <div class="name" title="${esc(r.name)}">${esc(r.name)}</div>
      <div class="track"><div class="fill" style="width:${((r.v || 0) / max) * 100}%"></div></div>
      <div class="v">${fmt(r.v)}</div>
    </div>`).join("");
}

function renderBaseline(K, nat) {
  const apA = baseline(BASE.airport[ROUTE.a], state.mi0, state.mi1);
  const apB = baseline(BASE.airport[ROUTE.b], state.mi0, state.mi1);
  const car = state.carrier ? baseline(BASE.carrier[state.carrier], state.mi0, state.mi1) : null;
  const rows = (k) => [
    { name: "This route", v: K[k], hl: true, tip: `<b>This route</b><br>${num(K.sched)} flights` },
    { name: `${ROUTE.a} airport`, v: apA?.[k], tip: `<b>All flights in/out of ${ROUTE.a}</b><br>${num(apA?.sched)} flights` },
    { name: `${ROUTE.b} airport`, v: apB?.[k], tip: `<b>All flights in/out of ${ROUTE.b}</b><br>${num(apB?.sched)} flights` },
    ...(car ? [{ name: `${META.carriers[state.carrier] || state.carrier} (all US)`, v: car[k], tip: `<b>${esc(META.carriers[state.carrier] || state.carrier)} nationwide</b><br>${num(car.sched)} flights` }] : []),
    { name: "All US flights", v: nat[k], tip: `<b>All reporting US flights</b><br>${num(nat.sched)} flights` },
  ];
  $("baseline").innerHTML = `
    <div class="hb-group"><div class="hb-title">Late arrivals</div><div class="hbars">${hbars(rows("delayRate"))}</div></div>
    <div class="hb-group"><div class="hb-title">Cancellations</div><div class="hbars">${hbars(rows("cancRate"))}</div></div>`;
}

function renderDirection(S) {
  const order = state.a === ROUTE.a ? [0, 1] : [1, 0];
  const [x, y] = order.map((d) => S.byDir[d]);
  const worseIdx = x.delayRate != null && y.delayRate != null && Math.abs(x.delayRate - y.delayRate) >= 0.03
    ? (x.delayRate > y.delayRate ? 0 : 1) : -1;
  $("direction").innerHTML = `<div class="dirs">${order.map((d, i) => {
    const k = S.byDir[d];
    const thin = k.sched < MIN_N ? ` <span class="thin-chip">low sample</span>` : "";
    return `<div class="dircard ${worseIdx === i ? "worse" : ""}">
      <h4>${dirLabel(d)}</h4>
      <div class="big">${pct(k.delayRate)} <small>late</small></div>${thin}
      <dl>
        <dt>Cancelled</dt><dd>${pct(k.cancRate)}</dd>
        <dt>Avg when late</dt><dd>${mins(k.meanLate)}</dd>
        <dt>1 hr+ late</dt><dd>${pct(k.sev60)}</dd>
        <dt>Flights</dt><dd>${num(k.sched)}</dd>
      </dl></div>`;
  }).join("")}</div>`;
}

function niceMax(v) {
  const steps = [0.05, 0.1, 0.2, 0.25, 0.4, 0.5, 0.6, 0.8, 1];
  return steps.find((s) => s >= v) || 1;
}

// Column chart. items: [{label, v, thin, tip}] ; opts: {avg, max}
function columns(items, { avg = null, max = null, every = 1 } = {}) {
  const top = max ?? niceMax(Math.max(avg || 0, ...items.map((i) => i.v || 0)));
  const ticks = [0, top / 2, top];
  return `
    <div class="cols">
      ${ticks.map((t) => `<div class="gridline" style="bottom:${(t / top) * 100}%"><span>${Math.round(t * 100)}%</span></div>`).join("")}
      ${avg != null ? `<div class="avg" style="bottom:${(avg / top) * 100}%"></div>` : ""}
      <div class="bars">${items.map((i) => `
        <div class="col ${i.v == null ? "empty" : ""} ${i.thin ? "thin" : ""}" data-tip="${esc(i.tip)}" tabindex="0" aria-label="${esc(i.aria || "")}">
          <div class="b" style="height:${i.v == null ? 0 : Math.max(1, (i.v / top) * 100)}%"></div>
        </div>`).join("")}
      </div>
    </div>
    <div class="xlabels">${items.map((i, n) => `<span>${n % every === 0 ? esc(i.label) : ""}</span>`).join("")}</div>`;
}

function dataTable(head, rows) {
  return `<details class="data"><summary>Data table</summary><div class="tbl-wrap"><table>
    <thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`;
}

const hourLabel = (h) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);
const cutTip = (title, c) => `<b>${title}</b><br>${pct(c.delayRate)} late · ${pct(c.cancRate)} cancelled<br>${num(c.sched)} flights${c.thin ? " · low sample" : ""}`;

function renderHours(S, K) {
  const hrs = S.hours;
  if (!hrs.length) { $("hours").innerHTML = `<p class="empty-msg">No flights in this selection.</p>`; $("banks").innerHTML = ""; return; }
  const first = Math.min(...hrs.map((h) => h.key)), last = Math.max(...hrs.map((h) => h.key));
  const items = [];
  for (let h = first; h <= last; h++) {
    const c = hrs.find((x) => x.key === h);
    const name = `${hourLabel(h)} departures`;
    items.push(c ? { label: hourLabel(h), v: c.delayRate, thin: c.thin, tip: cutTip(name, c), aria: `${name}: ${pct(c.delayRate)} late` }
      : { label: hourLabel(h), v: null, tip: `<b>${name}</b><br>No flights`, aria: `${name}: no flights` });
  }
  $("hours").innerHTML = columns(items, { avg: K.delayRate, every: items.length > 12 ? 2 : 1 }) +
    dataTable(["Hour", "Flights", "Late", "Cancelled"], hrs.map((h) => [hourLabel(h.key), num(h.sched), pct(h.delayRate), pct(h.cancRate)]));

  const ok = S.banks.filter((b) => !b.thin && b.delayRate != null);
  const best = ok.length > 1 ? ok.reduce((a, b) => (b.delayRate < a.delayRate ? b : a)) : null;
  const worst = ok.length > 1 ? ok.reduce((a, b) => (b.delayRate > a.delayRate ? b : a)) : null;
  $("banks").innerHTML = S.banks.filter((b) => b.sched > 0).map((b) => `
    <div class="bank ${b === best ? "best" : b === worst ? "worst" : ""}">
      <b>${b.name}</b>${b.label}
      <div class="r">${pct(b.delayRate, 0)}</div>
      ${b === best ? `<span class="tag">✓ Best</span>` : b === worst ? `<span class="tag">✕ Worst</span>` : b.thin ? `<span class="thin-chip">low sample</span>` : `<span class="tag">&nbsp;</span>`}
    </div>`).join("");
}

function renderCauses(K) {
  const c = K.causes;
  if (!K.delayed) { $("causes").innerHTML = `<p class="empty-msg">No late arrivals in this selection.</p>`; return; }
  const rows = CAUSE_KEYS.map((name, i) => ({
    name, v: c.share[i], hl: c.share[i] === Math.max(...c.share),
    tip: `<b>${name}</b><br>${pct(c.share[i])} of delay minutes<br>Present on ${pct(c.presence[i])} of late flights<br>Main cause on ${pct(c.primary[i])}`,
  }));
  $("causes").innerHTML = `
    <div class="hb-title">Share of delay minutes</div>
    <div class="hbars">${hbars(rows)}</div>
    <div class="ctrl"><b>${pct(c.controllable, 0)}</b>of delay minutes are within the airline’s control (carrier + late-arriving aircraft).</div>
    ${dataTable(["Cause", "Share of minutes", "Present on", "Main cause on"], CAUSE_KEYS.map((n, i) => [n, pct(c.share[i]), pct(c.presence[i]), pct(c.primary[i])]))}
    <p class="note" style="margin:8px 0 0">${num(K.delayed)} late flights. “Present on” counts every cause that added minutes, so it sums past 100%.</p>`;
}

function fillFlightSeg() {
  $("flightSeg").innerHTML = [["best", "Most reliable"], ["worst", "Least reliable"]].map(([v, l]) =>
    `<button type="button" role="radio" data-v="${v}" aria-checked="${state.flightSort === v}">${l}</button>`).join("");
}

const signed = (x) => (x == null ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(Math.round(x))} min`);

function scoreTip(f) {
  const p = f.pts;
  return `<b>${f.c} ${f.fn} · ${f.score} (${f.grade.g}) ${f.grade.label}</b><br>` +
    `Starts at 100<br>` +
    `−${p.late.toFixed(0)} late arrivals (${pct(f.delayRate, 0)} actual)<br>` +
    `−${p.canc.toFixed(0)} cancellations (${pct(f.cancRate, 1)} actual)<br>` +
    `−${p.delay.toFixed(0)} delay length (avg arrival ${signed(f.meanArr)})` +
    (f.sched < 60 ? `<br><i>${f.sched} flights: blended toward the route average</i>` : "");
}

function renderFlights(S) {
  const fl = S.flights.filter((f) => f.score != null);
  if (!fl.length) { $("flights").innerHTML = `<p class="empty-msg">No flight number has 10+ operations in this selection.</p>`; return; }
  const sorted = [...fl].sort((a, b) => state.flightSort === "best"
    ? b.score - a.score || a.delayRate - b.delayRate
    : a.score - b.score || b.delayRate - a.delayRate);
  const shown = state.showAllFlights ? sorted : sorted.slice(0, 8);
  $("flights").innerHTML = `<div class="tbl-wrap"><table class="flt">
    <thead><tr><th>Flight</th><th>Score</th><th>Departs</th><th class="ops">Ops</th><th>Late</th><th>Canc.</th><th>Avg arr.</th></tr></thead>
    <tbody>${shown.map((f) => `<tr>
      <td class="fl">${f.c} ${f.fn}<span class="sub">${dirLabel(f.dir)}</span></td>
      <td><span class="score g-${f.grade.g}" data-tip="${esc(scoreTip(f))}" tabindex="0" aria-label="Score ${f.score} of 100, grade ${f.grade.g}, ${f.grade.label}">${f.score}<i>${f.grade.g}</i></span></td>
      <td>${fmtTime(f.dep)}</td><td class="ops">${num(f.sched)}</td><td>${pct(f.delayRate, 0)}</td><td>${pct(f.cancRate, 0)}</td>
      <td>${f.meanArr == null ? "–" : `${f.meanArr > 0 ? "+" : ""}${Math.round(f.meanArr)}m`}</td></tr>`).join("")}</tbody>
  </table></div>
  ${sorted.length > 8 ? `<button class="more" type="button" id="moreFlights">${state.showAllFlights ? "Show fewer" : `Show all ${sorted.length} flights`}</button>` : ""}
  <div class="grade-key">${GRADES.map((g, i) => `<span><span class="score g-${g.g}">${g.g}</span>${i === 0 ? `${g.min}+` : i === GRADES.length - 1 ? `under ${GRADES[i - 1].min}` : `${g.min}–${GRADES[i - 1].min - 1}`}</span>`).join("")}</div>`;
  $("moreFlights")?.addEventListener("click", () => { state.showAllFlights = !state.showAllFlights; renderFlights(S); });
}

function renderMonths(S) {
  const ms = S.months;
  const short = (k) => monthLabel(META.months[k], true).split(" ")[0];
  const mk = (key, avg) => ms.map((m) => ({
    label: short(m.key), v: m.sched ? m[key] : null, thin: m.thin,
    tip: cutTip(monthLabel(META.months[m.key]), m), aria: `${monthLabel(META.months[m.key])}: ${pct(m[key])}`,
  }));
  const every = ms.length > 12 ? 2 : 1;
  $("months").innerHTML = `
    <div class="mini"><div class="chart-title">Late arrivals</div>${columns(mk("delayRate"), { avg: S.all.delayRate, every })}</div>
    <div class="mini"><div class="chart-title">Cancellations</div>${columns(mk("cancRate"), { avg: S.all.cancRate, every })}</div>
    ${dataTable(["Month", "Flights", "Late", "Cancelled"], ms.map((m) => [monthLabel(META.months[m.key]), num(m.sched), pct(m.delayRate), pct(m.cancRate)]))}`;
}

function renderDows(S, K) {
  const items = S.dows.map((d) => ({
    label: DOW[d.key], v: d.sched ? d.delayRate : null, thin: d.thin, tip: cutTip(DOW[d.key], d), aria: `${DOW[d.key]}: ${pct(d.delayRate)} late`,
  }));
  $("dows").innerHTML = `<div class="chart-title">Late arrivals</div>` + columns(items, { avg: K.delayRate }) +
    dataTable(["Day", "Flights", "Late", "Cancelled"], S.dows.map((d) => [DOW[d.key], num(d.sched), pct(d.delayRate), pct(d.cancRate)]));
}

/* ---------- tooltip (hover on desktop, tap on phones) ---------- */
function wireTooltip() {
  const tip = $("tip");
  let pinned = null;
  const show = (el, x, y) => {
    const html = el.dataset.tip; if (!html) return;
    tip.innerHTML = html; tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const left = Math.min(Math.max(8, x - r.width / 2), window.innerWidth - r.width - 8);
    const top = y - r.height - 14 < 8 ? y + 18 : y - r.height - 14;
    tip.style.left = `${left}px`; tip.style.top = `${top}px`;
  };
  const hide = () => { tip.hidden = true; document.querySelectorAll(".col.on").forEach((c) => c.classList.remove("on")); };
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const el = e.target.closest("[data-tip]");
    if (el && el.dataset.tip) show(el, e.clientX, e.clientY); else if (!pinned) hide();
  });
  document.addEventListener("click", (e) => {
    const el = e.target.closest(".col[data-tip], .hb[data-tip], .score[data-tip]");
    if (!el || el === pinned) { pinned = null; hide(); return; }
    hide(); pinned = el; el.classList.add("on");
    const r = el.getBoundingClientRect();
    show(el, r.left + r.width / 2, r.top + 20);
  });
  document.addEventListener("focusin", (e) => {
    const el = e.target.closest(".col[data-tip], .score[data-tip]");
    if (el) { const r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top + 20); }
  });
  window.addEventListener("scroll", () => { if (pinned) { pinned = null; hide(); } }, { passive: true });
}

boot();
