# Market briefs

Generates a pre-market **morning brief** and a post-close **evening recap** as
self-contained HTML one-pagers. Pulls prices from the TradingView app and free
news / Reddit / StockTwits / calendar feeds, writes a Claude-authored market read,
and saves everything dated. No keys, no paid APIs, no software downloaded — just
public data fetched at runtime.

## How to run it

- **The briefs (on demand):** say *"morning brief"* or *"evening recap"* to Claude in this
  project (or type `/morning-brief` / `/evening-recap`). The skills in
  `.claude/skills/morning-brief` and `.claude/skills/evening-recap` own the procedure.
  The old 8:00 AM / 5:00 PM Windows scheduled tasks were retired 2026-06-18 — run the briefs
  when you want them. `install-schedule.ps1` can re-register the two brief tasks if ever wanted.
- **The live feed (always on, in the cloud):** a deterministic web page rebuilt every ~15 min on
  weekdays by a free GitHub-Actions cron and served by GitHub Pages — runs with the laptop closed,
  no Anthropic API, no recurring cost. It replaced the old desktop-toast intraday watch.
  - Live: **https://jad-naitali.github.io/market-feed/market-feed.html**
  - Repo: **https://github.com/Jad-Naitali/market-feed** (this folder is the repo)
  - Force a rebuild: GitHub → Actions → "Live market feed" → Run workflow (tick `force_fetch`).

## The pieces

| File | What it does |
|---|---|
| `fetch-feeds.js` | Pulls everything from free sources: Yahoo prices (futures, VIX, SPY/QQQ, each symbol's % vs prior close incl. pre/post), per-symbol news (Google + Yahoo RSS, deduped + junk-filtered), Reddit RSS (relevance-filtered to on-topic posts), StockTwits sentiment (time-windowed, with sample size + msgs/hour velocity), **what each company posts on its official X account** (public syndication timeline, nitter RSS backup), **theme news tailored to Jad's exposure** (one Google-News query per theme: data centers, miners, AI), **market-wide sentiment gauges** (CNN Fear & Greed + crypto Fear & Greed), economic + earnings (today + 7 days) calendars, and crypto macro news (CoinDesk + The Block) when the watchlist holds crypto. Weekend-aware window; stamps a "prices as of" time and window bounds. Every source reports its own status; a dead feed degrades, never crashes the run. |
| `symbol map.json` | Routing table + watchlist cache: each instrument → how to look it up on each source (Yahoo / StockTwits / news query / Reddit subs / asset class / official X handle), plus a `section` (trading / macro / crypto, mirroring the TradingView watchlist's `###` headers) and a top-level `themes` block (Jad's exposure: data centers, miners, AI — each a Google-News query + keywords). Refreshed from TradingView when the app is up; used as-is when it isn't. An X handle is only stored after its profile identity is verified against the company — unverified = `x: null`, never a guess. Leveraged wrappers of a name already listed (IRE/IREZ → IREN, NEBX → NBIS) are intentionally excluded. |
| `append-history.js` | Appends deterministic rows per run to `sentiment history.csv`: one per ticker, benchmark rows (SPY/QQQ), gauge rows (`_FEARGREED_` / `_CRYPTOFNG_`), and a `_RUN_` status row. Prices read from the fetcher's Yahoo quotes. |
| `build-brief.js` | Injects a day's data object into the HTML template to produce the finished page. |
| `build archive page.js` | Regenerates `archive.html` at the root after every run: every past brief grouped by week (newest first), with morning/evening links and a one-line summary, so prior days stay one click away. |
| `brief-template.html` | The one-pager design (terminal aesthetic). Reads one `window.BRIEF_DATA` object; renders morning or evening layout off `meta.type`. Now also renders the gauge strip, hour:minute timestamps everywhere, company-post lines, a "Still in Play" running-stories section, a "Your Themes" section (data centers / miners / AI headlines), TRADING/MACRO tags on the watchlist cards, and a quiet list split into trading + macro lines. |
| `running stories.json` | The multi-day stories the briefs track, so a big Monday story is still surfaced Wednesday. Maintained by the skills each run: live stories carry a start date + latest line; resolved ones render once under "Closing out", then drop. No fixed day count — judgment-based. |
| `archive.html` | Generated index of every brief, grouped by week. Open it to jump to any prior day. |
| `run-scheduled-brief.ps1` | Scheduler entry point: soft-starts TradingView (watchlist only), runs Claude headless against the skill, opens the result. |
| `install-schedule.ps1` | Registers / removes the two **brief** scheduled tasks (morning + evening). Not auto-installed — the briefs run on demand; re-run this only if you want the timed tasks back. |
| `Briefs/<date>/` | Per-run output: raw feed pulls, the data object, and the HTML brief. |
| `sentiment history.csv` | Running deterministic record (schema v2): windowed StockTwits bull/bear + sample size + velocity, on-topic Reddit mentions, unique news count, price %. Gauge rows (`_FEARGREED_` / `_CRYPTOFNG_`) carry the market-wide score (normalized 0–1 in `st_bull_ratio`, detail in `note`). The timestamped history the knowledge base's backtest phase will use. (`sentiment history (v1, day one).csv` is the archived first-day schema.) |
| `build feed data.js` | **Live-feed orchestrator** the GitHub-Actions cron runs. Runs the intraday watcher once (events), reads the snapshot, runs the regime engine, computes the mood composite (unweighted mean of present gauges), and writes the three `docs/` files below. Deterministic — no Anthropic API. |
| `docs/market-feed.html` | The live feed page (self-contained, embedded font, inline-SVG charts). Fetches `feed-data.json` on load + every 60s. Served by GitHub Pages. |
| `docs/feed-data.json` · `docs/feed-events.json` · `docs/mood-history.csv` | Cron-generated: the current snapshot, the rolling 3-day event log, and the timeline history. |
| `.github/workflows/feed.yml` | The free cron: every 15 min on weekdays (~7am–6pm ET) + a manual "Run workflow" button (`force_fetch` to fetch off-hours). Node 20, no install step. |
| `sec-ticker-ids.json` | In-repo copy of the sector-desk ticker→SEC-CIK map, so the cloud runner can pull SEC filings (the original lives outside the repo). |

## Notes

- **Prices come from Yahoo, not the chart.** The brief never drives TradingView symbol-by-symbol;
  TradingView only supplies the watchlist (and the run falls back to the cached `symbol map.json`
  when the app is closed). A symbol with no quote shows blank, never a fabricated number.
- **Reddit** uses the public RSS feeds (the JSON API is IP-blocked on this network): on-topic
  mention counts and titles, no upvote weight. Per-ticker counts are sparse by design — only
  posts with the ticker in the title count, so a spike is meaningful and a 0 is honest.
- **StockTwits** ratios are time-windowed and carry their sample size (`tagged` n) plus a
  `msgs/hour` velocity. A ratio built on 2 messages is shown as a thin sample — don't read it
  as signal. Unauthenticated + rate-capped; a large watchlist runs slower (paginates per symbol).
- **Company posts on X** come from the public syndication timeline (no login, no install), with
  a nitter RSS backup. The fetcher re-checks the profile name every run, so a renamed or squatted
  handle drops its posts instead of showing the wrong account. Tickers without a verified handle
  are shown as such in the footer — an honest gap, not an error. A genuinely market-moving company
  post gets promoted into the main headlines.
- **Sentiment gauges:** CNN Fear & Greed needs browser-like request headers (the fetcher sends
  them); a 418 just means the gauge degraded that run. Each gauge shows today vs prior close / week /
  month so the direction is visible, and persists to the history CSV.
- **Timestamps everywhere:** every headline, company post, and calendar row carries its publish
  time (hour:minute ET); the header stamps when the brief was generated, when prices were read, and
  the exact data window. The newest bar on any feed can still be forming — times are surfaced so a
  number is never quoted without its as-of.
- **Tailored to your exposure.** The watchlist's sections drive emphasis: *trading* names (your basket)
  earn a card on anything real and are watched intraday; *macro* names (NVDA/MSFT/GOOGL/gold/oil/etc.) only
  earn a card on big news or a big move and go quiet intraday. The market read is written through the
  trading-basket lens, but war / Fed / big-IPO news always stays in the main headlines. The "Your Themes"
  section pulls data-center / miner / AI headlines from the `themes` queries in `symbol map.json` — edit
  those queries/keywords to retune, no code change. The intraday watch's NEWS trigger scopes the same way
  (`newsScope` in `intraday-watch.json`: `trading+themes` default, `all` for the old every-name behavior).
- **Blocked from this network (not shipped):** Reddit JSON API, Yahoo v7 batch quote, CBOE
  put/call. All 403. Worked around where possible (Reddit RSS, Yahoo v8 chart); CBOE deferred.
- The brief always names any feed that came back degraded rather than silently dropping it.
