"""
Write small summary CSVs to exports/ (repo root) for use outside the site,
e.g. a Claude dashboard or a Motion video. All files are aggregates; no row-level data.

Input : pipeline/bts_parquet/*.parquet
Output: exports/monthly_by_carrier.csv   every month x carrier (plus an ALL row per month)
        exports/routes.csv               airport pairs with 500+ flights, last 12 months
        exports/airports.csv             departures per airport, last 12 months
        exports/hours.csv                scheduled departure hour x carrier, last 12 months
        exports/weekdays.csv             day of week x carrier, last 12 months

Run: python export_summary.py
"""

from pathlib import Path

import duckdb

from build_data import CARRIER_NAMES

HERE = Path(__file__).resolve().parent
SRC = HERE / "bts_parquet"
OUT = HERE.parent / "exports"
CAUSES = ["CarrierDelay", "WeatherDelay", "NASDelay", "SecurityDelay", "LateAircraftDelay"]
CAUSE_COLS = ["carrier_min", "weather_min", "nas_min", "security_min", "late_aircraft_min"]


def main():
    OUT.mkdir(exist_ok=True)
    con = duckdb.connect()
    con.execute(f"""
        CREATE VIEW f AS
        SELECT
            strftime(FlightDate, '%Y-%m') AS month,
            FlightDate, Reporting_Airline AS carrier, Origin, Dest, OriginCityName,
            (COALESCE(CRSDepTime, 0) // 100) % 24 AS hour,
            isodow(FlightDate) AS dow,
            CAST(COALESCE(Cancelled,0) = 1 AS INTEGER) AS cancelled,
            CAST(COALESCE(Cancelled,0) = 0 AND COALESCE(Diverted,0) = 0 AS INTEGER) AS flown,
            CAST(COALESCE(Cancelled,0) = 0 AND COALESCE(Diverted,0) = 0 AND ArrDel15 = 1 AS INTEGER) AS late,
            CASE WHEN COALESCE(Cancelled,0) = 0 AND COALESCE(Diverted,0) = 0 THEN ArrDelay END AS arr,
            {", ".join(f"CASE WHEN ArrDel15 = 1 AND COALESCE(Cancelled,0) = 0 AND COALESCE(Diverted,0) = 0 THEN COALESCE({c},0) ELSE 0 END AS {n}" for c, n in zip(CAUSES, CAUSE_COLS))}
        FROM read_parquet('{SRC.as_posix()}/ontime_*.parquet', union_by_name=true)
    """)
    con.execute("CREATE TABLE names (code VARCHAR, carrier_name VARCHAR)")
    con.executemany("INSERT INTO names VALUES (?, ?)", list(CARRIER_NAMES.items()) + [("ALL", "All airlines")])
    last = con.execute("SELECT MAX(month) FROM f").fetchone()[0]
    first12 = con.execute(
        f"SELECT strftime(CAST('{last}-01' AS DATE) - INTERVAL 11 MONTH, '%Y-%m')").fetchone()[0]
    recent = f"month BETWEEN '{first12}' AND '{last}'"
    win = f"'{first12}' AS window_start, '{last}' AS window_end"

    measures = f"""
        COUNT(*) AS scheduled, SUM(cancelled) AS cancelled, SUM(flown) AS flown, SUM(late) AS late,
        ROUND(SUM(late) / NULLIF(SUM(flown), 0), 4) AS late_rate,
        ROUND(SUM(cancelled) / COUNT(*), 4) AS cancel_rate,
        ROUND(AVG(CASE WHEN late = 1 THEN arr END), 1) AS avg_delay_when_late,
        SUM(CASE WHEN arr >= 60 THEN 1 ELSE 0 END) AS late_60plus,
        {", ".join(f"CAST(SUM({n}) AS BIGINT) AS {n}" for n in CAUSE_COLS)}
    """

    con.execute(f"""
        COPY (
            SELECT t.*, COALESCE(n.carrier_name, t.carrier) AS carrier_name FROM (
            SELECT month, carrier, {measures} FROM f GROUP BY month, carrier
            UNION ALL
            SELECT month, 'ALL' AS carrier, {measures} FROM f GROUP BY month
            ) t LEFT JOIN names n ON n.code = t.carrier ORDER BY month, carrier
        ) TO '{(OUT / "monthly_by_carrier.csv").as_posix()}' (HEADER)
    """)
    con.execute(f"""
        COPY (
            SELECT LEAST(Origin, Dest) AS airport_a, GREATEST(Origin, Dest) AS airport_b,
                   LEAST(Origin, Dest) || '-' || GREATEST(Origin, Dest) AS route,
                   COUNT(DISTINCT carrier) AS carriers, {win}, {measures}
            FROM f WHERE {recent}
            GROUP BY ALL HAVING COUNT(*) >= 500 ORDER BY scheduled DESC
        ) TO '{(OUT / "routes.csv").as_posix()}' (HEADER)
    """)
    con.execute(f"""
        COPY (
            SELECT Origin AS airport, ANY_VALUE(OriginCityName) AS city, {win}, {measures}
            FROM f WHERE {recent} GROUP BY Origin HAVING COUNT(*) >= 1000 ORDER BY scheduled DESC
        ) TO '{(OUT / "airports.csv").as_posix()}' (HEADER)
    """)
    con.execute(f"""
        COPY (
            SELECT t.*, COALESCE(n.carrier_name, t.carrier) AS carrier_name FROM (
            SELECT hour, carrier, {win}, {measures} FROM f WHERE {recent} GROUP BY hour, carrier
            UNION ALL
            SELECT hour, 'ALL', {win}, {measures} FROM f WHERE {recent} GROUP BY hour
            ) t LEFT JOIN names n ON n.code = t.carrier ORDER BY hour, carrier
        ) TO '{(OUT / "hours.csv").as_posix()}' (HEADER)
    """)
    con.execute(f"""
        COPY (
            SELECT t.*, COALESCE(n.carrier_name, t.carrier) AS carrier_name FROM (
            SELECT dow, ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][dow] AS day, carrier, {win}, {measures}
            FROM f WHERE {recent} GROUP BY dow, carrier
            UNION ALL
            SELECT dow, ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][dow], 'ALL', {win}, {measures}
            FROM f WHERE {recent} GROUP BY dow
            ) t LEFT JOIN names n ON n.code = t.carrier ORDER BY dow, carrier
        ) TO '{(OUT / "weekdays.csv").as_posix()}' (HEADER)
    """)
    for p in sorted(OUT.glob("*.csv")):
        print(f"{p.name}: {p.stat().st_size / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
