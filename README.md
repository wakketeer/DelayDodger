# DelayDodger

Pick any two US airports and see how often flights on that route arrive late or get cancelled, why it happens, and when to fly to avoid it. Built on the US DOT Bureau of Transportation Statistics (BTS) Reporting Carrier On-Time Performance data. It covers every domestic flight by every reporting US carrier.

It's a static site on GitHub Pages: there's no server, no login, and it works on phones. A GitHub Action handles the data. It downloads new BTS months every Monday, aggregates them into small per-route files, checks them against a known-good result, and redeploys.

## How it works

```
BTS PREZIP ──> GitHub Action: ingest.py ──> Parquet (Actions cache)
                               build_data.py (DuckDB) ──> site/data/*.json
                               validate_fixture.mjs ──> GitHub Pages
```

| File | Role |
|---|---|
| `pipeline/ingest.py` | Downloads monthly BTS zips into `pipeline/bts_parquet/`. The window is rolling: up to 24 months, never earlier than 2025-06. |
| `pipeline/build_data.py` | Uses DuckDB to write `site/data/meta.json`, `baselines.json`, and one `r/<A>-<B>.json` per airport pair. |
| `site/metrics.js` | All metric math. The browser and the fixture test both use it. |
| `pipeline/validate_fixture.mjs` | Runs DFW↔GSO on AA, Jun 2025 – May 2026. It must return 1,442 flights, 32.3% late, 3.8% cancelled, and a 56.1% late-aircraft share, or the deploy fails. |
| `site/index.html`, `app.js`, `styles.css` | The app. Shareable links use the URL hash, e.g. `#DFW-GSO?c=AA&f=2025-06&t=2026-05`. |

## One-time setup

1. Create a **public** repo `evolvconsulting/delaydodger` and push these files to `main`.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. In **Settings → Actions → General**, allow actions to run, if org policy requires it.
4. In **Actions → Build data and deploy**, click **Run workflow**. The first run downloads about 15 months of data, roughly 4 GB, and takes 20–40 minutes. Later runs only fetch new months.
5. The site is published at `https://evolvconsulting.github.io/delaydodger/`.

## Notes

- BTS publishes about 2–3 months behind. Each Monday run picks up a new month as soon as it's posted. It also keeps the Actions cache warm, since GitHub evicts caches that go unused for 7 days.
- The BTS download quirks are handled in `ingest.py`: the filename has no parentheses, there are no HEAD requests, it sends a browser User-Agent, and it uses `verify=False`.
- Rates on fewer than 30 flights are flagged as low sample. Flight numbers need 10 or more operations to appear on the leaderboard.
- The carrier filter matches on `Reporting_Airline`.
- To run locally: `pip install -r pipeline/requirements.txt`, `python pipeline/ingest.py`, `python pipeline/build_data.py`, then `python -m http.server -d site`.

Built by evolv Consulting.
