"""
Aggregate the BTS Parquet files into the static data the web app reads.

Input : pipeline/bts_parquet/*.parquet   (from ingest.py)
Output: site/data/meta.json              months, airports, carriers, route index
        site/data/baselines.json         national / airport / carrier monthly rates
        site/data/r/<A>-<B>.json         one file per airport pair (A < B alphabetically)

Each route file holds small columnar "cubes" keyed by direction, carrier and month,
so the browser can re-slice by carrier, direction and date window without a server.
All metric math lives in site/metrics.js; this script only counts and sums.

Run: python build_data.py
"""

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import numpy as np

HERE = Path(__file__).resolve().parent
SRC = HERE / "bts_parquet"
SITE = HERE.parent / "site"
OUT = SITE / "data"

CAUSES = ["CarrierDelay", "WeatherDelay", "NASDelay", "SecurityDelay", "LateAircraftDelay"]
HIST_MIN, HIST_MAX, HIST_W = -12, 36, 5   # 5-min ArrDelay bins, clamped to [-60, 180+]

CARRIER_NAMES = {
    "AA": "American", "AS": "Alaska", "B6": "JetBlue", "DL": "Delta", "F9": "Frontier",
    "G4": "Allegiant", "HA": "Hawaiian", "MQ": "Envoy", "NK": "Spirit", "OH": "PSA",
    "OO": "SkyWest", "UA": "United", "WN": "Southwest", "YX": "Republic", "9E": "Endeavor",
    "QX": "Horizon", "YV": "Mesa", "EV": "ExpressJet", "C5": "CommutAir", "G7": "GoJet",
    "PT": "Piedmont", "ZW": "Air Wisconsin", "MX": "Breeze", "VX": "Virgin America",
}


def q(con, sql):
    return con.execute(sql).df()


def cols(df, names):
    """DataFrame -> {col: list} with ints where possible (compact JSON)."""
    out = {}
    for n in names:
        s = df[n]
        if s.dtype.kind == "f":
            s = s.fillna(0).round().astype(np.int64)
        out[n] = s.tolist()
    return out


def main():
    files = sorted(SRC.glob("ontime_*.parquet"))
    if not files:
        raise SystemExit(f"No parquet files in {SRC}. Run ingest.py first.")

    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    con.execute(f"""
        CREATE VIEW raw AS SELECT * FROM read_parquet('{SRC.as_posix()}/ontime_*.parquet', union_by_name=true)
    """)
    months = [r[0] for r in con.execute(
        "SELECT DISTINCT strftime(FlightDate, '%Y-%m') m FROM raw ORDER BY m").fetchall()]
    mi_case = "CASE " + " ".join(
        f"WHEN ym = '{m}' THEN {i}" for i, m in enumerate(months)) + " END"

    cause_pos = " OR ".join(f"COALESCE({c},0) > 0" for c in CAUSES)
    greatest = "GREATEST(" + ", ".join(f"COALESCE({c},0)" for c in CAUSES) + ")"
    primary = "CASE WHEN NOT (" + cause_pos + ") THEN NULL " + " ".join(
        f"WHEN COALESCE({c},0) = {greatest} THEN {i}" for i, c in enumerate(CAUSES)) + " END"

    con.execute(f"""
        CREATE TABLE f AS
        WITH base AS (
            SELECT *, strftime(FlightDate, '%Y-%m') AS ym FROM raw
        )
        SELECT
            LEAST(Origin, Dest)    AS A,
            GREATEST(Origin, Dest) AS B,
            CASE WHEN Origin <= Dest THEN 0 ELSE 1 END AS dir,
            Origin, Dest, Reporting_Airline AS c,
            Flight_Number_Reporting_Airline AS fn,
            {mi_case} AS mi,
            (COALESCE(CRSDepTime, 0) // 100) % 24 AS hr,
            CAST(CRSDepTime AS INTEGER) AS crs,
            isodow(FlightDate) - 1 AS dow,                       -- 0 = Mon
            CAST(COALESCE(Cancelled,0) = 1 AS INTEGER) AS canc,
            CAST(COALESCE(Diverted,0) = 1 AS INTEGER)  AS dv,
            CAST(COALESCE(Cancelled,0) = 0 AND COALESCE(Diverted,0) = 0 AS INTEGER) AS flown,
            CAST(COALESCE(Cancelled,0) = 0 AND COALESCE(Diverted,0) = 0
                 AND ArrDel15 = 1 AS INTEGER) AS d15,
            CASE WHEN COALESCE(Cancelled,0) = 0 AND COALESCE(Diverted,0) = 0
                 THEN ArrDelay END AS arr,
            {", ".join(f"COALESCE({c},0) AS {c}" for c in CAUSES)},
            {primary} AS pc,
            OriginCityName, DestCityName
        FROM base
    """)
    n_rows = con.execute("SELECT COUNT(*) FROM f").fetchone()[0]
    print(f"{n_rows:,} flights across {len(months)} months ({months[0]}..{months[-1]})")

    late = "d15 = 1"
    # ---- month cube: everything, keyed by route/dir/carrier/month -----------------
    m = q(con, f"""
        SELECT A, B, dir, c, mi,
            COUNT(*) sched, SUM(canc) canc, SUM(dv) dv, SUM(flown) flown, SUM(d15) d15,
            COUNT(arr) narr, SUM(arr) sarr,
            SUM(CASE WHEN {late} THEN arr ELSE 0 END) slate,
            SUM(CASE WHEN arr >= 60 THEN 1 ELSE 0 END) s60,
            SUM(CASE WHEN arr >= 120 THEN 1 ELSE 0 END) s120,
            {", ".join(f"SUM(CASE WHEN {late} THEN {c} ELSE 0 END) cm{i}" for i, c in enumerate(CAUSES))},
            {", ".join(f"SUM(CASE WHEN {late} AND {c} > 0 THEN 1 ELSE 0 END) cp{i}" for i, c in enumerate(CAUSES))},
            {", ".join(f"SUM(CASE WHEN {late} AND pc = {i} THEN 1 ELSE 0 END) pp{i}" for i in range(len(CAUSES)))},
            SUM(CASE WHEN {late} AND pc IS NOT NULL THEN 1 ELSE 0 END) dwc
        FROM f GROUP BY ALL ORDER BY A, B, dir, c, mi
    """)
    hist = q(con, f"""
        SELECT A, B, dir, c, mi,
               LEAST(GREATEST(CAST(FLOOR(arr / {HIST_W}) AS INTEGER), {HIST_MIN}), {HIST_MAX}) bin,
               COUNT(*) n
        FROM f WHERE arr IS NOT NULL GROUP BY ALL ORDER BY A, B, dir, c, mi, bin
    """)
    h = q(con, """
        SELECT A, B, dir, c, mi, hr, COUNT(*) sched, SUM(canc) canc, SUM(flown) flown, SUM(d15) d15
        FROM f GROUP BY ALL ORDER BY A, B, dir, c, mi, hr
    """)
    d = q(con, """
        SELECT A, B, dir, c, mi, dow, COUNT(*) sched, SUM(canc) canc, SUM(flown) flown, SUM(d15) d15
        FROM f GROUP BY ALL ORDER BY A, B, dir, c, mi, dow
    """)
    fl = q(con, """
        SELECT A, B, dir, c, fn, mi, COUNT(*) sched, SUM(canc) canc, SUM(flown) flown,
               SUM(d15) d15, COUNT(arr) narr, SUM(arr) sarr, MODE(crs) dep
        FROM f WHERE fn IS NOT NULL GROUP BY ALL ORDER BY A, B, dir, c, fn, mi
    """)

    # ---- baselines ---------------------------------------------------------------
    nat = q(con, "SELECT mi, COUNT(*) sched, SUM(canc) canc, SUM(flown) flown, SUM(d15) d15 FROM f GROUP BY mi ORDER BY mi")
    apt = q(con, """
        SELECT ap, mi, COUNT(*) sched, SUM(canc) canc, SUM(flown) flown, SUM(d15) d15 FROM (
            SELECT Origin ap, mi, canc, flown, d15 FROM f
            UNION ALL
            SELECT Dest ap, mi, canc, flown, d15 FROM f
        ) GROUP BY ap, mi ORDER BY ap, mi
    """)
    car = q(con, "SELECT c, mi, COUNT(*) sched, SUM(canc) canc, SUM(flown) flown, SUM(d15) d15 FROM f GROUP BY c, mi ORDER BY c, mi")

    names = q(con, """
        SELECT ap, ANY_VALUE(city) city FROM (
            SELECT Origin ap, OriginCityName city FROM f UNION ALL SELECT Dest, DestCityName FROM f
        ) GROUP BY ap
    """)
    routes = q(con, """
        SELECT A, B, COUNT(*) n, LIST(DISTINCT c ORDER BY c) cs FROM f GROUP BY A, B ORDER BY A, B
    """)

    # ---- write -------------------------------------------------------------------
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "r").mkdir(parents=True)

    def dense(df, key):
        return {k: cols(g, ["mi", "sched", "canc", "flown", "d15"]) for k, g in df.groupby(key)}

    baselines = {
        "national": cols(nat, ["mi", "sched", "canc", "flown", "d15"]),
        "airport": dense(apt, "ap"),
        "carrier": dense(car, "c"),
    }
    (OUT / "baselines.json").write_text(json.dumps(baselines, separators=(",", ":")))

    carriers_seen = sorted(car["c"].unique().tolist())
    meta = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "months": months,
        "flights": int(n_rows),
        "causes": ["Carrier", "Weather", "NAS (air traffic)", "Security", "Late aircraft"],
        "carriers": {c: CARRIER_NAMES.get(c, c) for c in carriers_seen},
        "airports": dict(zip(names["ap"], names["city"].fillna(""))),
        "routes": [[a, b, int(n), list(cs)] for a, b, n, cs in routes.itertuples(index=False)],
    }
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))

    m_cols = (["dir", "c", "mi", "sched", "canc", "dv", "flown", "d15", "narr", "sarr", "slate",
               "s60", "s120", "dwc"] + [f"cm{i}" for i in range(5)] + [f"cp{i}" for i in range(5)]
              + [f"pp{i}" for i in range(5)])
    hd_cols = ["dir", "c", "mi", "sched", "canc", "flown", "d15"]
    f_cols = ["dir", "c", "fn", "mi", "sched", "canc", "flown", "d15", "narr", "sarr", "dep"]

    hist_map = {}
    for (a, b, dr, c, mi), g in hist.groupby(["A", "B", "dir", "c", "mi"], sort=False):
        flat = []
        for bn, n in zip(g["bin"].tolist(), g["n"].tolist()):
            flat += [int(bn), int(n)]
        hist_map[(a, b, dr, c, mi)] = flat

    groups = {k: {"m": g} for k, g in m.groupby(["A", "B"], sort=False)}
    for name, df in (("h", h), ("d", d), ("f", fl)):
        for k, g in df.groupby(["A", "B"], sort=False):
            groups[k][name] = g

    for (a, b), parts in groups.items():
        mdf = parts["m"]
        doc = {
            "a": a, "b": b,
            "m": cols(mdf, m_cols),
            "hist": [hist_map.get((a, b, r.dir, r.c, r.mi), [])
                     for r in mdf[["dir", "c", "mi"]].itertuples(index=False)],
            "h": cols(parts["h"], hd_cols + ["hr"]),
            "d": cols(parts["d"], hd_cols + ["dow"]),
            "f": cols(parts["f"], f_cols) if "f" in parts else {k: [] for k in f_cols},
        }
        (OUT / "r" / f"{a}-{b}.json").write_text(json.dumps(doc, separators=(",", ":")))

    total = sum(p.stat().st_size for p in OUT.rglob("*.json"))
    print(f"Wrote {len(groups):,} route files + meta + baselines ({total / 1e6:.1f} MB) to {OUT}")


if __name__ == "__main__":
    main()
