#!/usr/bin/env node
/*
 * fetch-feeds.js — pulls free market data feeds for the morning brief / evening recap.
 *
 * No dependencies. No npm install. Built-in fetch only (Node 18+).
 * Downloads DATA at runtime (RSS / public JSON), never software — per the project safety rule.
 *
 * Usage:
 *   node fetch-feeds.js --symbols-file "symbol map.json" --out "raw pulls.json" [--runtype morning|evening]
 *   node fetch-feeds.js --tickers TSLA,AAPL,NVDA --out out.json     (each treated as a default equity)
 *
 * Window: by default, hours since the last regular-session close (weekend-aware — Friday
 * 4 PM ET to Monday morning is ~66h). Override with --window-hours N.
 *
 * Output: one consolidated JSON. Every source carries a status so the brief can say which
 * source is missing instead of silently omitting it. Nothing here is load-bearing — a dead
 * feed degrades to a status note, it never crashes the run.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---- config -----------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 1;                 // one retry on timeout / 5xx
const REDDIT_THROTTLE_MS = 1100;       // ~1 req/sec, polite to unauthenticated reddit
const STOCKTWITS_THROTTLE_MS = 350;    // ~200 req/hr cap; stay well under in a burst
const STOCKTWITS_MAX_PAGES = 3;        // pages of ~30 messages each, when window needs them
const UA = 'Mozilla/5.0 (market-briefs; local research tool) AppleWebKit/537.36';
const X_THROTTLE_MS = 1500;            // syndication endpoint rate-limits hard; space the calls
// X syndication + CNN need a real browser User-Agent or they 429 / 418.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const CNN_FNG_HEADERS = {
  'User-Agent': BROWSER_UA,
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.cnn.com/markets/fear-and-greed',
  Origin: 'https://www.cnn.com',
};
// SEC EDGAR asks for a descriptive User-Agent with a contact; ~10 req/s cap (trivial here).
const SEC_HEADERS = { 'User-Agent': 'TDV-MCP market-brief research jnaitali@foodtastic.ca', 'Accept-Encoding': 'gzip, deflate' };
const SEC_THROTTLE_MS = 150;      // space the per-company submissions calls, polite to EDGAR
const SEC_LOOKBACK_DAYS = 45;     // how far back the filing feed reaches (desk wants history; the alert dedups new)
const SEC_CIK_FILE = path.join(__dirname, '..', 'Sector Desk', 'ticker-to-sec-id.json');
const REDDIT_HEADERS = {
  'User-Agent': 'windows:market-briefs:v1.0 (personal research tool)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
};
// SEO/spam domains seen polluting ticker news — dropped from counts and lists.
const NEWS_DOMAIN_BLOCKLIST = ['fathomjournal', 'fool.com.au'];
const NEWS_TITLE_BLOCK = [
  /\b(crackdown|takeover!!|powerhouse|confirmed\?!)\b/i,
  // MarketBeat-class 13F / ownership-filing bot spam — pure noise for a market brief
  /\b(stake|position|holdings?|shares?)\b.{0,40}\b(raised|boosted|lowered|trimmed|cut|reduced|increased|decreased|acquired|sold|purchased|bought)\b/i,
  /\bpurchases?\s+[\d,]+\s+shares\b/i,
  /\bhas\s+\$[\d.]+\s+(million|billion)\s+(stock\s+)?(holdings|position|stake)\b/i,
];

// ---- arg parsing ------------------------------------------------------------

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--tickers') a.tickers = argv[++i];
    else if (k === '--tickers-file') a.tickersFile = argv[++i];
    else if (k === '--symbols-file') a.symbolsFile = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--window-hours') a.windowHours = Number(argv[++i]);
    else if (k === '--runtype') a.runtype = argv[++i];
    else if (k === '--light') a.light = true;
  }
  return a;
}

// ---- time helpers (Eastern-aware, DST-correct via Intl) ---------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "now" parts in America/New_York, without pulling in a tz library
function etParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  return { weekday: p.weekday, dateStr: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour === '24' ? 0 : p.hour) };
}

function etDateStr(d = new Date()) { return etParts(d).dateStr; }

// Hours since the most recent regular-session close (16:00 ET, weekdays).
// Run Monday 8 AM -> back to Friday 16:00 ET (~66h). Run Wed 8 AM -> Tue 16:00 (~16h).
function hoursSinceLastClose() {
  const now = new Date();
  // Walk back hour by hour (cheap, robust across DST) to the latest past weekday 16:00 ET.
  for (let back = 0; back < 24 * 5; back++) {
    const probe = new Date(now.getTime() - back * 3600 * 1000);
    const p = etParts(probe);
    const isWeekday = !['Sat', 'Sun'].includes(p.weekday);
    if (isWeekday && p.hour < 16) continue; // before today's close, keep walking back
    if (isWeekday && p.hour >= 16) {
      // this probe is at/after a weekday 16:00 — the close at 16:00 of this ET day is the anchor
      const closeOfDay = new Date(probe.getTime() - (p.hour - 16) * 3600 * 1000);
      const h = (now - closeOfDay) / 3600000;
      if (h >= 0.5) return Math.round(h);
    }
  }
  return 18; // fallback
}

function withinWindow(timestampMs, windowHours) {
  if (!timestampMs) return true; // keep undated items rather than guess them stale
  return Date.now() - timestampMs <= windowHours * 3600 * 1000;
}

// ---- http -------------------------------------------------------------------

async function getText(url, { headers = {}, retries = MAX_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: controller.signal, redirect: 'follow' });
      const text = await res.text();
      clearTimeout(timer);
      if (res.status >= 500 && attempt < retries) { await sleep(400); continue; } // retry 5xx
      return { ok: res.ok, status: res.status, text };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) { await sleep(400); continue; } // retry network/timeout
    }
  }
  throw lastErr;
}

async function getJson(url, opts) {
  const r = await getText(url, opts);
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return JSON.parse(r.text);
}

function statusFor(err) {
  if (err && (err.status === 429 || err.status === 403)) return 'rate_limited';
  if (err && err.name === 'AbortError') return 'error: timeout';
  if (err && err.message && /certificate|self-signed|unable to verify|self signed/i.test(err.message)) {
    return 'error: tls (corporate inspection? retry with --use-system-ca)';
  }
  return `error: ${err && err.message ? err.message : 'unknown'}`;
}

// ---- RSS / Atom parsing -----------------------------------------------------

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : null;
}

function parseRss(xml, windowHours) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks) {
    const title = tag(block, 'title');
    if (!title) continue;
    let link = tag(block, 'link');
    if (!link) { const m = block.match(/<link[^>]*href="([^"]+)"/i); if (m) link = m[1]; }
    const dateStr = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated');
    const ts = dateStr ? Date.parse(dateStr) : null;
    if (!withinWindow(ts, windowHours)) continue;
    items.push({ title, link, published: dateStr || null, ts: ts || null });
  }
  return items;
}

// ---- news: relevance, dedup, junk filter -----------------------------------

function normalizeTitle(t) {
  return t.toLowerCase().replace(/\s+-\s+[^-]+$/, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function isJunk(item) {
  const link = (item.link || '').toLowerCase();
  if (NEWS_DOMAIN_BLOCKLIST.some((d) => link.includes(d))) return true;
  if (NEWS_TITLE_BLOCK.some((re) => re.test(item.title))) return true;
  return false;
}

// token-overlap dedupe within one ticker's headlines (Google + Yahoo often repeat a story)
function dedupeNews(items) {
  const kept = [];
  const seen = [];
  for (const it of items) {
    if (isJunk(it)) continue;
    const norm = normalizeTitle(it.title);
    const toks = new Set(norm.split(' ').filter((w) => w.length > 3));
    let dup = false;
    for (const s of seen) {
      const overlap = [...toks].filter((w) => s.has(w)).length;
      const ratio = overlap / Math.max(1, Math.min(toks.size, s.size));
      if (ratio >= 0.6) { dup = true; break; }
    }
    if (!dup) { kept.push(it); seen.push(toks); }
  }
  return kept;
}

function titleMatchesTicker(title, ticker) {
  if (!title) return false;
  if (title.includes('$' + ticker)) return true;
  return new RegExp(`\\b${ticker}\\b`).test(title); // ticker is upper-case; titles keep case
}

// ---- per-symbol news --------------------------------------------------------

async function fetchSymbolNews(entry, windowHours) {
  const out = { google: { status: 'ok', items: [] }, yahoo: { status: 'ok', items: [] }, unique: 0 };
  const gq = encodeURIComponent(entry.newsQuery || (entry.ticker + ' stock'));
  try {
    const r = await getText(`https://news.google.com/rss/search?q=${gq}&hl=en-US&gl=US&ceid=US:en`);
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    out.google.items = parseRss(r.text, windowHours).slice(0, 10);
    if (!out.google.items.length) out.google.status = 'empty';
  } catch (e) { out.google.status = statusFor(e); }

  if (entry.class === 'equity') {
    try {
      const r = await getText(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(entry.yahoo || entry.ticker)}&region=US&lang=en-US`);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      out.yahoo.items = parseRss(r.text, windowHours).slice(0, 8);
      if (!out.yahoo.items.length) out.yahoo.status = 'empty';
    } catch (e) { out.yahoo.status = statusFor(e); }
  } else {
    out.yahoo.status = 'n/a';
  }

  const merged = dedupeNews([...out.google.items, ...out.yahoo.items]);
  out.deduped = merged.slice(0, 8);
  out.unique = merged.length;
  return out;
}

// ---- broad market + crypto macro RSS ---------------------------------------

async function fetchFeedList(feeds, windowHours) {
  const result = [];
  for (const f of feeds) {
    try {
      const r = await getText(f.url, f.headers ? { headers: f.headers } : undefined);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      const items = parseRss(r.text, windowHours).slice(0, 8);
      result.push({ source: f.name, status: items.length ? 'ok' : 'empty', items });
    } catch (e) {
      result.push({ source: f.name, status: statusFor(e), items: [] });
    }
  }
  return result;
}

const fetchBroadMarket = (windowHours) => fetchFeedList([
  { name: 'CNBC top news', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { name: 'MarketWatch top', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { name: 'Google News — stock market', url: 'https://news.google.com/rss/search?q=stock%20market&hl=en-US&gl=US&ceid=US:en' },
], windowHours);

const fetchCryptoNews = (windowHours) => fetchFeedList([
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'The Block', url: 'https://www.theblock.co/rss.xml' },
], windowHours);

// ---- theme news (Jad's exposure: data centers, miners, AI) ------------------
// One Google-News query per theme from symbol map.json. Cheap (one RSS call each),
// so it runs even in --light mode — the intraday watch scopes its news trigger on
// these themes' keywords. Dedupes across themes; broad-market overlap is stripped in main.
async function fetchThemeNews(themes, windowHours) {
  const out = { status: 'ok', byTheme: [] };
  const seen = []; // token sets across all themes, first occurrence wins
  let anyError = false;
  for (const th of themes || []) {
    const entry = { name: th.name, query: th.query, keywords: th.keywords || [], status: 'ok', items: [] };
    try {
      const r = await getText(`https://news.google.com/rss/search?q=${encodeURIComponent(th.query)}&hl=en-US&gl=US&ceid=US:en`);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      for (const it of parseRss(r.text, windowHours)) {
        if (isJunk(it)) continue;
        const toks = new Set(normalizeTitle(it.title).split(' ').filter((w) => w.length > 3));
        const dup = seen.some((s) => [...toks].filter((w) => s.has(w)).length / Math.max(1, Math.min(toks.size, s.size)) >= 0.6);
        if (dup) continue;
        seen.push(toks);
        entry.items.push({ title: it.title, link: it.link, ts: it.ts });
        if (entry.items.length >= 6) break;
      }
      if (!entry.items.length) entry.status = 'empty';
    } catch (e) { entry.status = statusFor(e); anyError = true; }
    out.byTheme.push(entry);
  }
  if (anyError) out.status = 'degraded';
  return out;
}

// ---- Reddit (relevance-filtered, sub-restricted) ----------------------------

function parseRedditAtom(xml, windowHours) {
  const posts = [];
  const blocks = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks) {
    const title = tag(block, 'title');
    if (!title) continue;
    const authorM = block.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/i);
    const author = authorM ? decodeEntities(authorM[1]) : null;
    const linkM = block.match(/<link[^>]*href="([^"]+)"/i);
    const url = linkM ? linkM[1] : null;
    const subM = url && url.match(/\/r\/([^/]+)\//);
    const dateStr = tag(block, 'updated') || tag(block, 'published');
    const ts = dateStr ? Date.parse(dateStr) : null;
    if (!withinWindow(ts, windowHours)) continue;
    posts.push({ title, author, sub: subM ? subM[1] : null, url, ts: ts || null });
  }
  return posts;
}

async function fetchRedditFeed(url, windowHours) {
  const r = await getText(url, { headers: REDDIT_HEADERS });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return parseRedditAtom(r.text, windowHours);
}

async function fetchReddit(entries, financeSubs, windowHours) {
  const out = { hot: {}, tickerMentions: {}, status: 'ok' };
  let anyError = false;

  // hot posts from the finance subs (context, not per-ticker)
  for (const sub of financeSubs) {
    try {
      const posts = (await fetchRedditFeed(`https://www.reddit.com/r/${sub}/hot.rss?limit=15`, windowHours))
        .filter((x) => x.author !== '/u/AutoModerator');
      out.hot[sub] = { status: posts.length ? 'ok' : 'empty', posts: posts.slice(0, 8) };
    } catch (e) { anyError = true; out.hot[sub] = { status: statusFor(e), posts: [] }; }
    await sleep(REDDIT_THROTTLE_MS);
  }

  // per-ticker search, restricted to the symbol's subs, then relevance-filtered on title
  for (const e of entries) {
    const subs = (e.redditSubs && e.redditSubs.length ? e.redditSubs : financeSubs).join('+');
    const url = `https://www.reddit.com/r/${subs}/search.rss?q=${encodeURIComponent('$' + e.ticker)}&restrict_sr=1&sort=new&t=week&limit=25`;
    try {
      const raw = await fetchRedditFeed(url, windowHours);
      const relevant = raw.filter((p) => titleMatchesTicker(p.title, e.ticker));
      out.tickerMentions[e.ticker] = {
        status: relevant.length ? 'ok' : 'empty',
        count: relevant.length,
        rawCount: raw.length,
        posts: relevant.slice(0, 6),
      };
    } catch (err) {
      anyError = true;
      out.tickerMentions[e.ticker] = { status: statusFor(err), count: 0, rawCount: 0, posts: [] };
    }
    await sleep(REDDIT_THROTTLE_MS);
  }

  if (anyError) out.status = 'degraded';
  return out;
}

// ---- StockTwits (time-windowed, paginated, with velocity) -------------------

async function fetchStockTwits(entries, windowHours) {
  const out = { byTicker: {}, status: 'ok' };
  let anyRateLimited = false;

  for (const e of entries) {
    if (!e.stocktwits) { out.byTicker[e.ticker] = { status: 'n/a' }; continue; }
    try {
      const collected = [];
      let cursorMax = null;
      let pages = 0;
      while (pages < STOCKTWITS_MAX_PAGES) {
        const url = `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(e.stocktwits)}.json`
          + (cursorMax ? `?max=${cursorMax}` : '');
        const json = await getJson(url);
        const msgs = json.messages || [];
        collected.push(...msgs);
        pages++;
        const oldest = msgs[msgs.length - 1];
        const oldestTs = oldest ? Date.parse(oldest.created_at) : 0;
        const oldestInWindow = withinWindow(oldestTs, windowHours);
        await sleep(STOCKTWITS_THROTTLE_MS);
        if (!json.cursor?.more || !oldestInWindow || !msgs.length) break;
        cursorMax = json.cursor.max;
      }
      // keep only messages inside the window, then tally
      const win = collected.filter((m) => withinWindow(Date.parse(m.created_at), windowHours));
      let bullish = 0, bearish = 0;
      for (const m of win) {
        const s = m.entities?.sentiment?.basic;
        if (s === 'Bullish') bullish++;
        else if (s === 'Bearish') bearish++;
      }
      const tagged = bullish + bearish;
      out.byTicker[e.ticker] = {
        status: win.length ? 'ok' : 'empty',
        windowMessages: win.length,
        msgsPerHour: Math.round((win.length / windowHours) * 10) / 10,
        bullish, bearish, tagged,
        bullRatio: tagged ? Math.round((bullish / tagged) * 1000) / 1000 : null,
        pagesPulled: pages,
        watchlistCount: null,
      };
    } catch (err) {
      const s = statusFor(err);
      if (s === 'rate_limited') anyRateLimited = true;
      out.byTicker[e.ticker] = { status: s, windowMessages: 0, msgsPerHour: 0, bullish: 0, bearish: 0, tagged: 0, bullRatio: null };
    }
  }

  if (anyRateLimited) out.status = 'rate_limited';
  return out;
}

// ---- Yahoo quotes (prices, decoupled from the TradingView chart) ------------

async function fetchOneQuote(yahooSymbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=2d&interval=1d&includePrePost=true`;
  const json = await getJson(url, { headers: { Accept: 'application/json' } });
  const m = json.chart?.result?.[0]?.meta;
  if (!m) throw new Error('no meta');
  const prev = m.chartPreviousClose ?? m.previousClose ?? null;
  const reg = m.regularMarketPrice ?? null;
  const last = (m.marketState === 'PRE' && m.preMarketPrice) ? m.preMarketPrice
    : (m.marketState === 'POST' && m.postMarketPrice) ? m.postMarketPrice
    : reg;
  const pct = (prev && last) ? Math.round(((last - prev) / prev) * 1000) / 10 : null;
  // when this quote was last updated (epoch ms); feeds the "prices as of" stamp
  const asOfSec = m.postMarketTime ?? m.preMarketTime ?? m.regularMarketTime ?? null;
  const asOfMs = asOfSec ? asOfSec * 1000 : null;
  return { yahoo: yahooSymbol, prevClose: prev, regular: reg, last, pct, marketState: m.marketState || null, asOfMs };
}

async function fetchQuotes(entries) {
  const out = { byTicker: {}, status: 'ok' };
  let anyError = false;
  const results = await Promise.all(entries.map(async (e) => {
    try { return [e.ticker, await fetchOneQuote(e.yahoo || e.ticker)]; }
    catch (err) { anyError = true; return [e.ticker, { status: statusFor(err), pct: null }]; }
  }));
  for (const [t, q] of results) out.byTicker[t] = q;
  if (anyError) out.status = 'degraded';
  return out;
}

async function fetchMarketState() {
  const futuresDefs = [
    { name: 'S&P 500 (ES)', yahoo: 'ES=F' },
    { name: 'Nasdaq 100 (NQ)', yahoo: 'NQ=F' },
    { name: 'VIX', yahoo: '^VIX', invert: true },
  ];
  const benchDefs = [{ ticker: 'SPY', yahoo: 'SPY' }, { ticker: 'QQQ', yahoo: 'QQQ' }];
  const futures = [];
  for (const f of futuresDefs) {
    try { const q = await fetchOneQuote(f.yahoo); futures.push({ name: f.name, value: q.last, change: q.pct, invert: !!f.invert }); }
    catch (e) { futures.push({ name: f.name, value: null, change: null, invert: !!f.invert, status: statusFor(e) }); }
  }
  const benchmarks = [];
  for (const b of benchDefs) {
    try { const q = await fetchOneQuote(b.yahoo); benchmarks.push({ ticker: b.ticker, pct: q.pct }); }
    catch (e) { benchmarks.push({ ticker: b.ticker, pct: null, status: statusFor(e) }); }
  }
  return { futures, benchmarks, putCall: null }; // putCall deferred: CBOE 403s from this network
}

// ---- calendars --------------------------------------------------------------

async function fetchEconCalendar() {
  try {
    const events = await getJson('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    const todayET = etDateStr(); // compare ET-date to ET-date (event dates carry the ET offset)
    const list = Array.isArray(events) ? events : [];
    const today = list
      .filter((e) => e.date && e.date.slice(0, 10) === todayET && e.country === 'USD' && (e.impact === 'High' || e.impact === 'Medium'))
      .map((e) => ({ title: e.title, time: e.date, impact: e.impact, forecast: e.forecast || null, previous: e.previous || null }));
    const weekAheadHigh = list
      .filter((e) => e.country === 'USD' && e.impact === 'High' && e.date && e.date.slice(0, 10) > todayET)
      .map((e) => ({ title: e.title, time: e.date, impact: e.impact }));
    return { status: 'ok', today, weekAheadHigh: weekAheadHigh.slice(0, 8) };
  } catch (e) { return { status: statusFor(e), today: [], weekAheadHigh: [] }; }
}

// Earnings: today + next 7 calendar days. One Nasdaq call per day, each degradable.
async function fetchEarnings(tickers) {
  const watchSet = new Set(tickers.map((t) => t.toUpperCase()));
  const watchlistReporting = [];
  let notableToday = [];
  let anyError = false;
  for (let d = 0; d < 8; d++) {
    const day = new Date(Date.now() + d * 86400000);
    const dateStr = etDateStr(day);
    try {
      const json = await getJson(`https://api.nasdaq.com/api/calendar/earnings?date=${dateStr}`, { headers: { Accept: 'application/json, text/plain, */*' } });
      const rows = json.data?.rows || [];
      if (d === 0) notableToday = rows.slice(0, 12).map((r) => ({ symbol: r.symbol, name: r.name, time: r.time, eps: r.epsForecast || null }));
      for (const r of rows) {
        if (watchSet.has((r.symbol || '').toUpperCase())) {
          watchlistReporting.push({ symbol: r.symbol, name: r.name, date: dateStr, daysOut: d, time: r.time, eps: r.epsForecast || null });
        }
      }
    } catch (e) { anyError = true; }
    await sleep(150);
  }
  return { status: anyError && !watchlistReporting.length ? 'degraded' : 'ok', watchlistReporting, notableToday, notableCount: notableToday.length };
}

// ---- company posts on X (official accounts only) ---------------------------

// case-insensitive token overlap: profile name must share a >=3-char token with the
// configured company name (or be an exact match). Guards against a renamed/squatted handle.
function identityMatches(profileName, configuredName) {
  if (!profileName || !configuredName) return false;
  const toks = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3));
  const a = toks(profileName), b = toks(configuredName);
  if (profileName.toLowerCase().trim() === configuredName.toLowerCase().trim()) return true;
  for (const w of a) if (b.has(w)) return true;
  return false;
}

// pull the company's own recent posts via the public syndication timeline (no auth, no install).
// Payload shape confirmed 2026-06-11: props.pageProps.timeline.entries[].content.tweet
// with full_text, created_at, id_str, user.{name,screen_name}, retweeted_status.
async function fetchCompanyPostsSyndication(handle, windowHours) {
  const r = await getText(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`,
    { headers: { 'User-Agent': BROWSER_UA } });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  const m = r.text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no __NEXT_DATA__');
  const data = JSON.parse(m[1]);
  // primary path, with a defensive deep-walk fallback if the structure shifts
  let tweets = [];
  try {
    tweets = (data.props.pageProps.timeline.entries || [])
      .map((e) => e && e.content && e.content.tweet).filter(Boolean);
  } catch (e) { /* fall through to walk */ }
  if (!tweets.length) {
    const found = [];
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (o.full_text && o.created_at) found.push(o);
      for (const k in o) walk(o[k]);
    })(data);
    tweets = found;
  }
  const profileName = tweets[0] && tweets[0].user ? tweets[0].user.name : null;
  const posts = tweets
    .filter((t) => !t.retweeted_status && !/^RT @/.test(t.full_text || ''))
    .map((t) => ({
      text: t.full_text,
      ts: t.created_at ? Date.parse(t.created_at) : null,
      url: t.permalink ? `https://x.com${t.permalink}` : `https://x.com/${handle}/status/${t.id_str}`,
    }))
    .filter((p) => withinWindow(p.ts, windowHours));
  return { via: 'syndication', profileName, posts };
}

// backup: nitter RSS (community mirror; flaky — serves an empty body to non-browser UAs and
// goes down often). Channel <title> ("Name / @handle") carries the profile name.
async function fetchCompanyPostsNitter(handle, windowHours) {
  const r = await getText(`https://nitter.net/${encodeURIComponent(handle)}/rss`, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/rss+xml, application/xml, text/xml, */*', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  if (!r.text || r.text.length < 100) throw new Error('empty nitter body'); // flaky instance served nothing
  const items = parseRss(r.text, windowHours);
  const chTitle = (r.text.match(/<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/i) || [])[1];
  const profileName = chTitle ? decodeEntities(chTitle).replace(/\s*\/\s*@.*$/, '').trim() : null;
  const posts = items
    .filter((i) => !/^RT by /i.test(i.title))
    .map((i) => ({ text: i.title, ts: i.ts, url: i.link }));
  return { via: 'nitter', profileName, posts };
}

async function fetchCompanyPosts(entries, windowHours) {
  const out = { byTicker: {}, status: 'ok' };
  let anyError = false, anyUnverified = false;
  for (const e of entries) {
    if (e.class !== 'equity') { out.byTicker[e.ticker] = { status: 'n/a' }; continue; }
    if (!e.x || !e.x.handle) { anyUnverified = true; out.byTicker[e.ticker] = { status: 'no verified handle' }; continue; }
    try {
      let res;
      try { res = await fetchCompanyPostsSyndication(e.x.handle, windowHours); }
      catch (err) { res = await fetchCompanyPostsNitter(e.x.handle, windowHours); }
      // live identity re-check; never silent-pass. Distinguish a genuine mismatch (squatting:
      // a real name that doesn't match) from an unreadable identity (fetch degraded / blocked).
      if (identityMatches(res.profileName, e.x.name)) {
        out.byTicker[e.ticker] = {
          status: res.posts.length ? 'ok' : 'empty',
          handle: e.x.handle, via: res.via, profileName: res.profileName,
          posts: res.posts.slice(0, 5),
        };
      } else {
        anyError = true;
        out.byTicker[e.ticker] = {
          status: res.profileName ? 'error: handle/profile mismatch' : 'error: could not verify identity',
          handle: e.x.handle, via: res.via, profileName: res.profileName || null, posts: [],
        };
      }
    } catch (err) {
      anyError = true;
      out.byTicker[e.ticker] = { status: statusFor(err), handle: e.x.handle, posts: [] };
    }
    await sleep(X_THROTTLE_MS);
  }
  out.status = anyError ? 'degraded' : (anyUnverified ? 'ok (some handles unverified)' : 'ok');
  return out;
}

// ---- market-wide sentiment gauges -------------------------------------------

async function fetchSentimentGauges() {
  const out = { status: 'ok', fearGreed: null, fearGreedStatus: 'ok', cryptoFearGreed: null, cryptoStatus: 'ok' };
  // CNN Fear & Greed — needs browser-like headers or returns 418. Score 0-100.
  try {
    const j = await getJson('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', { headers: CNN_FNG_HEADERS });
    const fg = j.fear_and_greed;
    if (fg) out.fearGreed = {
      score: Math.round(fg.score), rating: fg.rating,
      previousClose: Math.round(fg.previous_close),
      previous1Week: Math.round(fg.previous_1_week),
      previous1Month: Math.round(fg.previous_1_month),
      asOfMs: typeof fg.timestamp === 'number' ? fg.timestamp : Date.parse(fg.timestamp) || null,
    };
    else out.fearGreedStatus = 'empty';
  } catch (e) { out.fearGreedStatus = statusFor(e); }
  // Crypto Fear & Greed (alternative.me) — plain, no headers needed. limit=2 gives today + yesterday.
  try {
    const j = await getJson('https://api.alternative.me/fng/?limit=2');
    const [d0, d1] = j.data || [];
    if (d0) out.cryptoFearGreed = {
      value: Number(d0.value), rating: d0.value_classification,
      yesterdayValue: d1 ? Number(d1.value) : null,
      yesterdayRating: d1 ? d1.value_classification : null,
      asOfMs: d0.timestamp ? Number(d0.timestamp) * 1000 : null,
    };
    else out.cryptoStatus = 'empty';
  } catch (e) { out.cryptoStatus = statusFor(e); }
  if (out.fearGreedStatus !== 'ok' || out.cryptoStatus !== 'ok') out.status = 'degraded';
  return out;
}

// ---- SEC EDGAR filings (the sector catalyst backbone) -----------------------
// Per core name: pull recent material filings, classify into a plain catalyst type.
// This is the loudest signal in the miner-to-AI sector — deals re-rate these names,
// dilution offerings cut them in half, and both hit EDGAR before the price tells you.

// 8-K item codes → what they mean (the ones that matter for this sector)
//   1.01 material definitive agreement (a deal)   2.02 results (earnings)
//   2.03 direct financial obligation (debt)        3.02 unregistered equity sale (dilution)
//   7.01 Reg FD disclosure (announcement)          8.01 other events (often a deal PR)
function classifyFiling(form, items) {
  const f = (form || '').toUpperCase();
  const it = (items || '').split(',').map((s) => s.trim());
  const has = (code) => it.includes(code);
  // registered offerings / shelves → dilution risk, loudest
  if (/^S-1|^S-3|^424B|^F-1|^F-3/.test(f)) return 'financing/dilution';
  if (f === '8-K') {
    if (has('3.02') || has('2.03')) return 'financing/dilution'; // equity sale / new debt
    if (has('1.01') || has('7.01') || has('8.01')) return 'deal/capacity';
    if (has('2.02')) return 'earnings';
    return 'other';
  }
  if (/^SC 13D|^SC 13G|^13D|^13G/.test(f)) return 'control';
  if (f === '4' || f === '3' || f === '5') return 'insider';
  return 'other';
}
// loudness rank for ordering + alerting (dilution first — it's the money-saver)
const FILING_RANK = { 'financing/dilution': 0, 'deal/capacity': 1, earnings: 2, control: 3, insider: 4, other: 5 };
const SEC_KEEP_FORMS = /^(8-K|S-1|S-3|424B|F-1|F-3|SC 13D|SC 13G|13D|13G|4|3|5)/i;

// 8-K item codes → plain English, so the feed reads "Material agreement + New debt" not "1.01,2.03".
// 9.01 (exhibits) is boilerplate on almost every 8-K — dropped from the label as noise.
const ITEM_LABELS = {
  '1.01': 'Material agreement', '1.02': 'Agreement terminated', '2.01': 'Acquisition / disposition',
  '2.02': 'Earnings', '2.03': 'New debt / obligation', '3.01': 'Delisting notice',
  '3.02': 'Stock sale (dilution)', '3.03': 'Securityholder rights change', '5.02': 'Exec / board change',
  '5.07': 'Shareholder vote', '7.01': 'Announcement (Reg FD)', '8.01': 'Other event',
};
// plain-English label for a filing's form + items (for the catalyst feed + alerts)
function filingLabel(form, items) {
  const f = (form || '').toUpperCase();
  if (/^424B/.test(f)) return 'Stock offering (prospectus)';
  if (/^S-3|^F-3/.test(f)) return 'Shelf registration (dilution capacity)';
  if (/^S-1|^F-1/.test(f)) return 'IPO / registration';
  if (/^SC 13D|^13D/.test(f)) return 'Activist / control stake';
  if (/^SC 13G|^13G/.test(f)) return 'Passive 5%+ stake';
  if (f === '4' || f === '3' || f === '5') return 'Insider transaction';
  if (f === '8-K') {
    const labels = (items || '').split(',').map((s) => ITEM_LABELS[s.trim()]).filter(Boolean);
    return labels.length ? labels.join(' + ') : 'Material event';
  }
  return form || '';
}

// In-repo copy first (so the cloud cron, which can't see the parent Sector Desk folder,
// still gets SEC filings), then the parent Sector Desk map for the local setup.
const SEC_CIK_FILE_LOCAL = path.join(__dirname, 'sec-ticker-ids.json');
function loadCikMap() {
  for (const f of [SEC_CIK_FILE_LOCAL, SEC_CIK_FILE]) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')).names || {}; }
    catch (e) { /* try next */ }
  }
  return null;
}

async function fetchSecFilings(lookbackDays = SEC_LOOKBACK_DAYS) {
  const names = loadCikMap();
  if (!names) return { status: 'skipped', byTicker: {} };
  const out = { status: 'ok', byTicker: {} };
  const cutoff = Date.now() - lookbackDays * 86400 * 1000;
  let anyError = false;
  for (const ticker in names) {
    const meta = names[ticker];
    const entry = { cik: meta.cik, subGroup: meta.subGroup || null, status: 'ok', filings: [] };
    try {
      const j = await getJson(`https://data.sec.gov/submissions/CIK${meta.cik}.json`, { headers: SEC_HEADERS });
      const r = (j.filings && j.filings.recent) || {};
      const n = (r.form || []).length;
      for (let i = 0; i < n; i++) {
        const form = r.form[i];
        if (!SEC_KEEP_FORMS.test(form)) continue;
        const ts = Date.parse(r.acceptanceDateTime[i] || r.filingDate[i]);
        if (!ts || ts < cutoff) continue;
        const accNo = (r.accessionNumber[i] || '').replace(/-/g, '');
        const cikInt = String(Number(meta.cik));
        entry.filings.push({
          form, items: r.items[i] || '',
          type: classifyFiling(form, r.items[i]),
          label: filingLabel(form, r.items[i]),
          filedAt: ts,
          desc: r.primaryDocDescription[i] || r.core_type || '',
          url: `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNo}/${r.primaryDocument[i] || ''}`,
        });
        if (entry.filings.length >= 12) break; // newest-first; plenty for the feed + alert
      }
      if (!entry.filings.length) entry.status = 'empty';
    } catch (e) { entry.status = statusFor(e); anyError = true; }
    out.byTicker[ticker] = entry;
    await sleep(SEC_THROTTLE_MS);
  }
  if (anyError) out.status = 'degraded';
  return out;
}

// ---- symbol loading ---------------------------------------------------------

function defaultEntry(ticker) {
  const t = ticker.trim().toUpperCase();
  return { tv: t, ticker: t, yahoo: t, stocktwits: t, newsQuery: t + ' stock', class: 'equity', redditSubs: null };
}

function loadSymbols(args) {
  if (args.symbolsFile) {
    const map = JSON.parse(fs.readFileSync(args.symbolsFile, 'utf8'));
    const financeSubs = map.financeSubs || ['stocks', 'wallstreetbets', 'investing'];
    const cryptoSubs = map.cryptoSubs || ['CryptoCurrency'];
    const entries = (map.symbols || []).map((s) => ({
      tv: s.tv, ticker: s.ticker, yahoo: s.yahoo || s.ticker,
      stocktwits: s.stocktwits === undefined ? s.ticker : s.stocktwits,
      newsQuery: s.newsQuery || (s.ticker + ' stock'),
      class: s.class || 'equity',
      section: s.section || null,
      redditSubs: s.class === 'crypto' ? cryptoSubs : financeSubs,
      x: s.x || null,
    }));
    return { entries, financeSubs, themes: map.themes || [] };
  }
  const raw = args.tickers ? args.tickers.split(',') : (args.tickersFile ? JSON.parse(fs.readFileSync(args.tickersFile, 'utf8')) : []);
  const list = (Array.isArray(raw) ? raw : raw.tickers || []).map(String);
  const financeSubs = ['stocks', 'wallstreetbets', 'investing'];
  return { entries: list.map(defaultEntry).map((e) => ({ ...e, redditSubs: financeSubs })), financeSubs, themes: [] };
}

// ---- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const { entries, financeSubs, themes } = loadSymbols(args);
  if (!entries.length) { console.error('No symbols. Use --symbols-file or --tickers.'); process.exit(1); }

  const windowHours = args.windowHours || hoursSinceLastClose();
  const hasCrypto = entries.some((e) => e.class === 'crypto');
  const tickers = entries.map((e) => e.ticker);
  const windowEndMs = Date.now();
  const windowStartMs = windowEndMs - windowHours * 3600 * 1000;

  // --light: skip the slow/static feeds (Reddit pagination, StockTwits pagination, calendars)
  // for fast intraday polling. Keeps the change-detecting feeds: quotes, futures/VIX, per-symbol
  // news, company posts, gauges, crypto news.
  const light = !!args.light;
  const skip = (val) => Promise.resolve(val);
  const [perSymbolNews, broadMarket, themeNews, cryptoNews, reddit, stocktwits, quotes, marketState, econ, earnings, companyPosts, sentimentGauges, secFilings] = await Promise.all([
    Promise.all(entries.map(async (e) => [e.ticker, await fetchSymbolNews(e, windowHours)])),
    fetchBroadMarket(windowHours),
    fetchThemeNews(themes, windowHours),
    hasCrypto ? fetchCryptoNews(windowHours) : Promise.resolve([]),
    light ? skip({ hot: {}, tickerMentions: {}, status: 'skipped' }) : fetchReddit(entries, financeSubs, windowHours),
    light ? skip({ byTicker: {}, status: 'skipped' }) : fetchStockTwits(entries, windowHours),
    fetchQuotes(entries),
    fetchMarketState(),
    light ? skip({ status: 'skipped', today: [], weekAheadHigh: [] }) : fetchEconCalendar(),
    light ? skip({ status: 'skipped', watchlistReporting: [], notableToday: [], notableCount: 0 }) : fetchEarnings(tickers),
    fetchCompanyPosts(entries, windowHours),
    fetchSentimentGauges(),
    fetchSecFilings(),
  ]);

  const tickerNews = {};
  for (const [t, n] of perSymbolNews) tickerNews[t] = n;

  // drop theme headlines that already appear in the broad-market feed (don't show a story twice)
  const bmTitles = new Set(broadMarket.flatMap((b) => b.items).map((i) => normalizeTitle(i.title)));
  for (const th of themeNews.byTheme) th.items = th.items.filter((i) => !bmTitles.has(normalizeTitle(i.title)));

  // "prices as of" = newest quote timestamp across all symbols (falls back to now)
  const pricesAsOf = Object.values(quotes.byTicker)
    .map((q) => q && q.asOfMs).filter(Boolean)
    .reduce((mx, v) => Math.max(mx, v), 0) || windowEndMs;

  const result = {
    generatedAt: new Date().toISOString(),
    generatedAtMs: windowEndMs,
    asOfET: etDateStr() + ' ' + String(etParts().hour).padStart(2, '0') + ':00 ET',
    runType: args.runtype || 'adhoc',
    windowHours,
    window: { startMs: windowStartMs, endMs: windowEndMs },
    pricesAsOf,
    symbols: entries.map((e) => ({ ticker: e.ticker, class: e.class, section: e.section || null })),
    themes,
    marketState,
    quotes: quotes.byTicker,
    sources: {
      tickerNews, broadMarket, themeNews, cryptoNews,
      reddit, stocktwits, econCalendar: econ, earnings,
      companyPosts, sentimentGauges, secFilings,
    },
    sourceStatus: {
      quotes: quotes.status,
      broadMarket: broadMarket.map((b) => `${b.source}: ${b.status}`),
      themeNews: themeNews.byTheme.map((t) => `${t.name}: ${t.status}`),
      cryptoNews: hasCrypto ? cryptoNews.map((c) => `${c.source}: ${c.status}`) : 'n/a',
      reddit: reddit.status,
      stocktwits: stocktwits.status,
      econCalendar: econ.status,
      earnings: earnings.status,
      companyPosts: companyPosts.status,
      sentimentGauges: sentimentGauges.status,
      secFilings: secFilings.status,
    },
  };

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(result, null, 2), 'utf8');
    console.error(`Wrote ${args.out}  (window ${windowHours}h, ${entries.length} symbols)`);
  } else {
    process.stdout.write(JSON.stringify(result, null, 2));
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
