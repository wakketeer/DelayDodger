// Fixture test: the August 2026 prototype's known-good result for DFW <-> GSO on AA,
// Jun 2025 – May 2026. Runs the built site data through site/metrics.js (the same code
// the browser runs) and fails the build on any mismatch.
//
// Run: node pipeline/validate_fixture.mjs

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "../site/metrics.js";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "site", "data");
const FIX = {
  a: "DFW", b: "GSO", carrier: "AA", from: "2025-06", to: "2026-05",
  expect: { sched: 1442, delayRate: 32.3, cancRate: 3.8, lateAircraftShare: 56.1 },
};

const meta = JSON.parse(readFileSync(join(DATA, "meta.json"), "utf8"));
const mi0 = meta.months.indexOf(FIX.from);
const mi1 = meta.months.indexOf(FIX.to);
if (mi0 < 0 || mi1 < 0 || mi1 - mi0 !== 11) {
  console.warn(`Fixture window ${FIX.from}..${FIX.to} not fully in data (${meta.months[0]}..${meta.months.at(-1)}); skipping.`);
  process.exit(0);
}
const file = join(DATA, "r", `${FIX.a}-${FIX.b}.json`);
if (!existsSync(file)) {
  console.error(`FAIL: route file ${file} missing`);
  process.exit(1);
}
const route = JSON.parse(readFileSync(file, "utf8"));
const k = summarize(route, { carrier: FIX.carrier, mi0, mi1, dir: "both" }).all;
const got = {
  sched: k.sched,
  delayRate: +(k.delayRate * 100).toFixed(1),
  cancRate: +(k.cancRate * 100).toFixed(1),
  lateAircraftShare: +(k.causes.share[4] * 100).toFixed(1),
};

let ok = true;
for (const [key, want] of Object.entries(FIX.expect)) {
  const pass = got[key] === want;
  ok &&= pass;
  console.log(`${pass ? "PASS" : "FAIL"}  ${key.padEnd(18)} expected ${want}  got ${got[key]}`);
}
if (!ok) {
  console.error("Fixture mismatch: the pipeline or metric definitions drifted from the validated prototype.");
  process.exit(1);
}
console.log("Fixture OK: DFW <-> GSO, AA, Jun 2025 – May 2026");
