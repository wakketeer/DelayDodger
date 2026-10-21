// DelayDodger metric engine. Pure functions over the route cubes written by
// pipeline/build_data.py. Used by the browser (app.js) and by the fixture test
// (pipeline/validate_fixture.mjs), so the numbers the test checks are the numbers users see.

export const CAUSE_KEYS = ["Carrier", "Weather", "NAS", "Security", "Late aircraft"];
export const MIN_N = 30;           // min scheduled ops before a rate in a cut is shown unflagged
export const MIN_FLIGHT_OPS = 10;  // min ops for a flight number to make the leaderboard
export const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const BANKS = [
  { name: "Early morning", label: "5–8 am", hrs: [5, 6, 7, 8] },
  { name: "Late morning", label: "9–11 am", hrs: [9, 10, 11] },
  { name: "Midday", label: "12–2 pm", hrs: [12, 13, 14] },
  { name: "Afternoon", label: "3–5 pm", hrs: [15, 16, 17] },
  { name: "Evening", label: "6–8 pm", hrs: [18, 19, 20] },
  { name: "Night", label: "9 pm–4 am", hrs: [21, 22, 23, 0, 1, 2, 3, 4] },
];

const div = (a, b) => (b > 0 ? a / b : null);

/* ---------- Flight score ----------
   0–100, higher = more reliable. Starts at 100 and subtracts:
     • 1 pt per % of flights arriving 15+ min late
     • 3 pts per % cancelled (a cancellation costs a traveler far more than a delay)
     • 0.5 pt per minute of average arrival delay, capped at 20 pts (catches flights that are
       late less often but by a lot)
   Each rate is shrunk toward the route average for that direction, weighted as if the route
   had flown SCORE_PRIOR_OPS extra trips, so a flight with 0 of 44 late gets a strong score but
   not a perfect one. Grade bands are fixed so an "A" means the same thing on every route. */
export const SCORE_PRIOR_OPS = 20;
export const SCORE_W = { late: 100, canc: 300, minPerPt: 0.5, delayCap: 20 };
export const GRADES = [
  { g: "A", min: 85, label: "Very reliable" },
  { g: "B", min: 75, label: "Reliable" },
  { g: "C", min: 65, label: "Average" },
  { g: "D", min: 50, label: "Unreliable" },
  { g: "F", min: 0, label: "Very unreliable" },
];
export const gradeFor = (score) => (score == null ? null : GRADES.find((x) => score >= x.min));

// f: { sched, canc, flown, d15, narr, sarr }; prior: kpis() of the route in the same direction.
export function flightScore(f, prior) {
  const k = SCORE_PRIOR_OPS;
  const shrink = (num, den, p) => (p == null ? div(num, den) : (num + k * p) / (den + k));
  const late = shrink(f.d15, f.flown, prior?.delayRate);
  const canc = shrink(f.canc, f.sched, prior?.cancRate);
  const avgArr = shrink(f.sarr, f.narr, prior?.meanArr);
  if (late == null || canc == null) return null;
  const pts = {
    late: SCORE_W.late * late,
    canc: SCORE_W.canc * canc,
    delay: Math.min(SCORE_W.delayCap, SCORE_W.minPerPt * Math.max(0, avgArr || 0)),
  };
  const score = Math.round(Math.max(0, Math.min(100, 100 - pts.late - pts.canc - pts.delay)));
  return { score, grade: gradeFor(score), pts, adj: { late, canc, avgArr } };
}

// Indices of rows in a columnar table that match the selection.
// sel = { carrier: "" | "AA", mi0, mi1, dir: "both" | 0 | 1 }
export function select(t, sel, { ignoreDir = false } = {}) {
  const out = [];
  const n = t.mi ? t.mi.length : 0;
  for (let i = 0; i < n; i++) {
    if (t.mi[i] < sel.mi0 || t.mi[i] > sel.mi1) continue;
    if (sel.carrier && t.c[i] !== sel.carrier) continue;
    if (!ignoreDir && sel.dir !== "both" && t.dir[i] !== sel.dir) continue;
    out.push(i);
  }
  return out;
}

function sum(t, idx, names) {
  const s = {};
  for (const k of names) s[k] = 0;
  for (const i of idx) for (const k of names) s[k] += t[k][i] || 0;
  return s;
}

const M_FIELDS = ["sched", "canc", "dv", "flown", "d15", "narr", "sarr", "slate", "s60", "s120", "dwc",
  "cm0", "cm1", "cm2", "cm3", "cm4", "cp0", "cp1", "cp2", "cp3", "cp4", "pp0", "pp1", "pp2", "pp3", "pp4"];

function medianFromHist(route, idx) {
  const bins = new Map();
  let n = 0;
  for (const i of idx) {
    const flat = route.hist[i];
    for (let j = 0; j < flat.length; j += 2) {
      bins.set(flat[j], (bins.get(flat[j]) || 0) + flat[j + 1]);
      n += flat[j + 1];
    }
  }
  if (!n) return null;
  const keys = [...bins.keys()].sort((a, b) => a - b);
  let cum = 0;
  const half = n / 2;
  for (const k of keys) {
    const c = bins.get(k);
    if (cum + c >= half) return k * 5 + ((half - cum) / c) * 5; // linear interpolation inside the 5-min bin
    cum += c;
  }
  return keys[keys.length - 1] * 5;
}

export function kpis(route, idx) {
  const s = sum(route.m, idx, M_FIELDS);
  const causeMin = [s.cm0, s.cm1, s.cm2, s.cm3, s.cm4];
  const totalMin = causeMin.reduce((a, b) => a + b, 0);
  return {
    sched: s.sched, canc: s.canc, diverted: s.dv, flown: s.flown, delayed: s.d15,
    cancRate: div(s.canc, s.sched),
    delayRate: div(s.d15, s.flown),
    meanArr: div(s.sarr, s.narr),
    medianArr: medianFromHist(route, idx),
    meanLate: div(s.slate, s.d15),
    sev60: div(s.s60, s.flown),
    sev120: div(s.s120, s.flown),
    causes: {
      minutes: causeMin,
      share: causeMin.map((v) => div(v, totalMin)),
      presence: [s.cp0, s.cp1, s.cp2, s.cp3, s.cp4].map((v) => div(v, s.d15)),
      primary: [s.pp0, s.pp1, s.pp2, s.pp3, s.pp4].map((v) => div(v, s.dwc)),
      controllable: div(s.cm0 + s.cm4, totalMin),
      delayedWithCause: s.dwc,
    },
  };
}

function cut(t, idx, key, keys) {
  const acc = new Map(keys.map((k) => [k, { key: k, sched: 0, canc: 0, flown: 0, d15: 0 }]));
  for (const i of idx) {
    const k = t[key][i];
    if (!acc.has(k)) acc.set(k, { key: k, sched: 0, canc: 0, flown: 0, d15: 0 });
    const a = acc.get(k);
    a.sched += t.sched[i]; a.canc += t.canc[i]; a.flown += t.flown[i]; a.d15 += t.d15[i];
  }
  return [...acc.values()].map((a) => ({
    ...a, delayRate: div(a.d15, a.flown), cancRate: div(a.canc, a.sched), thin: a.sched < MIN_N,
  }));
}

export function flights(route, sel) {
  const t = route.f;
  const prior = [0, 1].map((d) => kpis(route, select(route.m, { ...sel, dir: d })));
  const idx = select(t, sel);
  const acc = new Map();
  for (const i of idx) {
    const k = `${t.dir[i]}|${t.c[i]}|${t.fn[i]}`;
    if (!acc.has(k)) acc.set(k, { dir: t.dir[i], c: t.c[i], fn: t.fn[i], sched: 0, canc: 0, flown: 0, d15: 0, narr: 0, sarr: 0, deps: new Map() });
    const a = acc.get(k);
    a.sched += t.sched[i]; a.canc += t.canc[i]; a.flown += t.flown[i]; a.d15 += t.d15[i];
    a.narr += t.narr[i]; a.sarr += t.sarr[i];
    a.deps.set(t.dep[i], (a.deps.get(t.dep[i]) || 0) + t.sched[i]);
  }
  return [...acc.values()]
    .filter((a) => a.sched >= MIN_FLIGHT_OPS)
    .map((a) => {
      const dep = [...a.deps.entries()].sort((x, y) => y[1] - x[1])[0][0];
      delete a.deps;
      return { ...a, dep, delayRate: div(a.d15, a.flown), cancRate: div(a.canc, a.sched), meanArr: div(a.sarr, a.narr), ...flightScore(a, prior[a.dir]) };
    });
}

export function summarize(route, sel) {
  const mIdx = select(route.m, sel);
  const hIdx = select(route.h, sel);
  const dIdx = select(route.d, sel);
  const months = [];
  for (let mi = sel.mi0; mi <= sel.mi1; mi++) months.push(mi);
  const hours = cut(route.h, hIdx, "hr", []).filter((h) => h.sched > 0).sort((a, b) => a.key - b.key);
  return {
    all: kpis(route, mIdx),
    byDir: [0, 1].map((d) => kpis(route, select(route.m, { ...sel, dir: d }))),
    hours,
    banks: BANKS.map((b) => {
      const hs = hours.filter((h) => b.hrs.includes(h.key));
      const s = hs.reduce((a, h) => ({ sched: a.sched + h.sched, flown: a.flown + h.flown, d15: a.d15 + h.d15, canc: a.canc + h.canc }), { sched: 0, flown: 0, d15: 0, canc: 0 });
      return { ...b, ...s, delayRate: div(s.d15, s.flown), cancRate: div(s.canc, s.sched), thin: s.sched < MIN_N };
    }),
    dows: cut(route.d, dIdx, "dow", [0, 1, 2, 3, 4, 5, 6]).sort((a, b) => a.key - b.key),
    months: cut(route.m, mIdx, "mi", months).sort((a, b) => a.key - b.key),
    flights: flights(route, sel),
  };
}

// National / airport / carrier rates over the same month window.
export function baseline(t, mi0, mi1) {
  if (!t) return null;
  let sched = 0, canc = 0, flown = 0, d15 = 0;
  for (let i = 0; i < t.mi.length; i++) {
    if (t.mi[i] < mi0 || t.mi[i] > mi1) continue;
    sched += t.sched[i]; canc += t.canc[i]; flown += t.flown[i]; d15 += t.d15[i];
  }
  return { sched, delayRate: div(d15, flown), cancRate: div(canc, sched) };
}

const pct = (x) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
const pts = (x) => `${(Math.abs(x) * 100).toFixed(0)} pts`;
export const fmtTime = (crs) => {
  if (crs == null) return "–";
  const h = Math.floor(crs / 100) % 24, m = crs % 100;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
};

// Plain-language booking advice. Returns [{ title, body }].
export function recommend(route, sel, meta) {
  const dirs = sel.dir === "both" ? [0, 1] : [sel.dir];
  const label = (d) => (d === 0 ? `${route.a} → ${route.b}` : `${route.b} → ${route.a}`);
  const S = summarize(route, sel);
  const recs = [];
  if (S.all.sched < MIN_N) {
    return [{ title: "Not enough flights", body: `Only ${S.all.sched} scheduled flights match this selection. Widen the date window or clear the airline filter for reliable advice.` }];
  }

  // 1. Best departure bank, per direction
  const timeLines = [];
  for (const d of dirs) {
    const s = summarize(route, { ...sel, dir: d });
    const ok = s.banks.filter((b) => !b.thin && b.delayRate != null);
    if (ok.length < 2) continue;
    const best = ok.reduce((a, b) => (b.delayRate < a.delayRate ? b : a));
    const worst = ok.reduce((a, b) => (b.delayRate > a.delayRate ? b : a));
    timeLines.push(`${label(d)}: book ${best.name.toLowerCase()} (${best.label}) — ${pct(best.delayRate)} arrive late, vs ${pct(worst.delayRate)} for ${worst.name.toLowerCase()} departures.`);
  }
  if (timeLines.length) recs.push({ title: "Best time to depart", body: timeLines.join(" ") });

  // 2. Flights to pick / avoid
  const fl = S.flights.filter((f) => f.score != null);
  if (fl.length >= 2) {
    const sorted = [...fl].sort((a, b) => b.score - a.score);
    const name = (f) => `${f.c} ${f.fn} (${label(f.dir)}, ${fmtTime(f.dep)})`;
    const desc = (f) => `${name(f)}, score ${f.score} (${f.grade.g}), ${pct(f.delayRate)} late`;
    const best = sorted.slice(0, Math.min(2, sorted.length));
    const worst = sorted.slice(-2).reverse().filter((f) => f.score < 50 && !best.includes(f));
    let body = `Most reliable: ${best.map(desc).join("; ")}.`;
    if (worst.length) body += ` Avoid: ${worst.map(desc).join("; ")}.`;
    recs.push({ title: "Flights to book and avoid", body });
  }

  // 3. Direction
  if (sel.dir === "both" && S.byDir[0].flown >= MIN_N && S.byDir[1].flown >= MIN_N) {
    const gap = S.byDir[0].delayRate - S.byDir[1].delayRate;
    if (Math.abs(gap) >= 0.03) {
      const worse = gap > 0 ? 0 : 1;
      recs.push({ title: "Direction matters", body: `${label(worse)} runs ${pts(gap)} worse than ${label(1 - worse)} (${pct(S.byDir[worse].delayRate)} vs ${pct(S.byDir[1 - worse].delayRate)} late). Build extra buffer on that leg.` });
    } else {
      recs.push({ title: "Direction", body: `Both directions perform about the same (${pct(S.byDir[0].delayRate)} vs ${pct(S.byDir[1].delayRate)} late).` });
    }
  }

  // 4. Days of week
  const days = S.dows.filter((x) => !x.thin && x.delayRate != null).sort((a, b) => a.delayRate - b.delayRate);
  if (days.length >= 3) {
    const worst = days[days.length - 1];
    recs.push({ title: "Best days to fly", body: `${DOW[days[0].key]} (${pct(days[0].delayRate)}) and ${DOW[days[1].key]} (${pct(days[1].delayRate)}) have the fewest late arrivals; ${DOW[worst.key]} is worst (${pct(worst.delayRate)}).` });
  }

  // 5. Cancellation contingency months
  const avgC = S.all.cancRate || 0;
  const bad = S.months.filter((x) => !x.thin && x.cancRate != null && x.cancRate >= Math.max(2 * avgC, avgC + 0.02));
  if (S.months.length >= 3) {
    recs.push({
      title: "Cancellation risk by month",
      body: bad.length
        ? `Have a backup plan in ${bad.map((x) => `${monthLabel(meta.months[x.key])} (${pct(x.cancRate)} cancelled)`).join(", ")} — at least double the ${pct(avgC)} average.`
        : `No month stands out; cancellations average ${pct(avgC)} across the window.`,
    });
  }

  // 6. Who's to blame
  const c = S.all.causes;
  if (c.controllable != null && S.all.delayed >= MIN_N) {
    const top = c.share.indexOf(Math.max(...c.share));
    let body = `${pct(c.controllable)} of delay minutes trace to the airline (its own operations plus late-arriving aircraft). The biggest single cause is ${CAUSE_KEYS[top].toLowerCase()} at ${pct(c.share[top])}.`;
    if (c.share[4] >= 0.3) body += " Late inbound aircraft compound through the day, so earlier departures inherit less delay.";
    recs.push({ title: "Why flights run late", body });
  }
  return recs;
}

export function monthLabel(ym, short = false) {
  const [y, m] = ym.split("-").map(Number);
  const n = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return short ? `${n} ’${String(y).slice(2)}` : `${n} ${y}`;
}
