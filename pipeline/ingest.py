"""
BTS On-Time Performance ingest: all US reporting carriers, all routes.
Downloads monthly PREZIP files and writes one Parquet file per month to
pipeline/bts_parquet/ (next to this script).

Run:  python ingest.py                    (rolling window, see below)
      python ingest.py 2025-06 2026-05    (explicit range, inclusive)

Rolling window: from max(FLOOR_MONTH, latest - (MAX_MONTHS-1)) to the latest
published month. Months outside the window are deleted so the cache stays lean.
Idempotent: months already on disk are skipped.
"""

import os
import sys
import time
import zipfile
import tempfile
import warnings
from pathlib import Path

import pandas as pd
import requests
import urllib3

# BTS's TLS cert chain is chronically broken; verify=False is required in practice.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
warnings.filterwarnings("ignore")

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
# No parentheses in the real filename (the site's display name has them; it 404s).
BASE_URL = (
    "https://transtats.bts.gov/PREZIP/"
    "On_Time_Reporting_Carrier_On_Time_Performance_1987_present_{year}_{month}.zip"
)
COLS = [
    "FlightDate", "Reporting_Airline", "Flight_Number_Reporting_Airline",
    "Origin", "OriginCityName", "Dest", "DestCityName", "CRSDepTime",
    "DepDelay", "ArrDelay", "ArrDel15", "Cancelled", "Diverted",
    "CarrierDelay", "WeatherDelay", "NASDelay", "SecurityDelay", "LateAircraftDelay",
]
FLOAT_COLS = ["DepDelay", "ArrDelay", "ArrDel15", "Cancelled", "Diverted",
              "CarrierDelay", "WeatherDelay", "NASDelay", "SecurityDelay",
              "LateAircraftDelay"]

MAX_MONTHS = int(os.environ.get("MAX_MONTHS", "24"))
FLOOR_MONTH = pd.Period(os.environ.get("FLOOR_MONTH", "2025-06"), "M")  # keeps the validation fixture in range

OUT = Path(__file__).resolve().parent / "bts_parquet"
OUT.mkdir(exist_ok=True)


def url_for(m):
    return BASE_URL.format(year=m.year, month=m.month)


def is_published(m):
    # BTS rejects HEAD; probe with a streamed GET and close without reading the body.
    for attempt in range(3):
        try:
            r = requests.get(url_for(m), verify=False, timeout=60, headers=HEADERS, stream=True)
            r.close()
            return r.status_code == 200
        except requests.RequestException as e:
            print(f"(probe error: {e}; retrying) ", end="", flush=True)
            time.sleep(10 * (attempt + 1))
    return False


def latest_published():
    probe = (pd.Timestamp.today() - pd.DateOffset(months=1)).to_period("M")
    for _ in range(8):
        print(f"Probing {probe} ... ", end="", flush=True)
        if is_published(probe):
            print("available")
            return probe
        print("not published yet")
        probe -= 1
    raise SystemExit("No published BTS month found in the last 8 probes. "
                     "Check https://transtats.bts.gov/PREZIP/ manually.")


def download(m, path):
    for attempt in range(4):
        try:
            with requests.get(url_for(m), verify=False, timeout=900,
                              headers=HEADERS, stream=True) as r:
                r.raise_for_status()
                with open(path, "wb") as fh:
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        fh.write(chunk)
            return
        except requests.RequestException as e:
            wait = 30 * (attempt + 1)
            print(f"\n  download error ({e}); retrying in {wait}s ... ", end="", flush=True)
            time.sleep(wait)
    raise SystemExit(f"Failed to download {m} after 4 attempts.")


def ingest_month(m, dest):
    print(f"{m}: downloading ... ", end="", flush=True)
    with tempfile.TemporaryDirectory() as tmp:
        zpath = Path(tmp) / "month.zip"
        download(m, zpath)
        with zipfile.ZipFile(zpath) as zf:
            csv_name = [n for n in zf.namelist() if n.endswith(".csv")][0]
            df = pd.read_csv(zf.open(csv_name), usecols=COLS, low_memory=False)
    df["FlightDate"] = pd.to_datetime(df["FlightDate"])
    df["Flight_Number_Reporting_Airline"] = pd.to_numeric(
        df["Flight_Number_Reporting_Airline"], errors="coerce").astype("Int32")
    df["CRSDepTime"] = pd.to_numeric(df["CRSDepTime"], errors="coerce").astype("Int32")
    for c in FLOAT_COLS:
        df[c] = pd.to_numeric(df[c], errors="coerce").astype("float64")
    for c in ["Reporting_Airline", "Origin", "Dest", "OriginCityName", "DestCityName"]:
        df[c] = df[c].astype("string")
    df.to_parquet(dest, index=False)
    print(f"{len(df):,} flights -> {dest.name}")


def main():
    if len(sys.argv) == 3:
        start, end = pd.Period(sys.argv[1], "M"), pd.Period(sys.argv[2], "M")
        prune = False
    else:
        end = latest_published()
        start = max(FLOOR_MONTH, end - (MAX_MONTHS - 1))
        prune = True

    wanted = {f"ontime_{m.year}_{m.month:02d}.parquet"
              for m in pd.period_range(start, end, freq="M")}

    for m in pd.period_range(start, end, freq="M"):
        dest = OUT / f"ontime_{m.year}_{m.month:02d}.parquet"
        if dest.exists():
            print(f"{m}: already ingested, skipping")
            continue
        ingest_month(m, dest)

    if prune:
        for p in OUT.glob("ontime_*.parquet"):
            if p.name not in wanted:
                print(f"Pruning {p.name} (outside {start}..{end})")
                p.unlink()

    print(f"\nDone. Window {start}..{end}. Parquet files in {OUT}")


if __name__ == "__main__":
    main()
