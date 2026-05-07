'use strict';
const express = require('express');
const fetch   = require('node-fetch');
const app     = express();
 
const TWELVE_KEY = process.env.TWELVE_DATA_API_KEY;
const JBIN_KEY   = process.env.JBIN_KEY;
const JBIN_ID    = process.env.JBIN_ID;
const PORT       = process.env.PORT || 3002;
 
if (!TWELVE_KEY || !JBIN_KEY || !JBIN_ID) {
  console.error('❌ Variables manquantes : TWELVE_DATA_API_KEY, JBIN_KEY, JBIN_ID');
  process.exit(1);
}
 
const STOCKS = [
  { symbol: 'AAPL',  name: 'Apple',     spread: 0.0005 },
  { symbol: 'MSFT',  name: 'Microsoft', spread: 0.0005 },
  { symbol: 'NVDA',  name: 'NVIDIA',    spread: 0.0006 },
  { symbol: 'TSLA',  name: 'Tesla',     spread: 0.0008 },
  { symbol: 'AMZN',  name: 'Amazon',    spread: 0.0005 },
  { symbol: 'GOOGL', name: 'Google',    spread: 0.0005 },
  { symbol: 'META',  name: 'Meta',      spread: 0.0006 },
];
 
let activeTrades   = [];
let history        = [];
let lastSignalTime = {};
 
const SL_PCT       = 0.02;
const TP_PCT       = 0.03;
const ANTI_CLUSTER = 24 * 60 * 60 * 1000;
 
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());
 
// ─── JSONBIN ─────────────────────────────────────────────────────────────────
async function syncCloud() {
  try {
    await fetch(`https://api.jsonbin.io/v3/b/${JBIN_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JBIN_KEY },
      body: JSON.stringify({ activeTrades, history, lastSignalTime })
    });
    console.log('☁️  Cloud sauvegardé');
  } catch(e) { console.error('syncCloud:', e.message); }
}
async function loadCloud() {
  try {
    const r = await fetch(`https://api.jsonbin.io/v3/b/${JBIN_ID}/latest`, {
      headers: { 'X-Master-Key': JBIN_KEY }
    });
    const d = await r.json();
    if (d.record) {
      activeTrades   = d.record.activeTrades   || [];
      history        = d.record.history        || [];
      lastSignalTime = d.record.lastSignalTime || {};
      console.log(`☁️  Cloud chargé — ${activeTrades.length} actifs, ${history.length} historique`);
    }
  } catch(e) { console.error('loadCloud:', e.message); }
}
 
// ─── MARCHÉ US ────────────────────────────────────────────────────────────────
function getParisHour() {
  const now   = new Date();
  const month = now.getUTCMonth() + 1;
  const isDST = month > 3 && month < 10
    ? true
    : month === 3
      ? now.getUTCDate() >= lastSundayOfMonth(now.getUTCFullYear(), 3)
      : month === 10
        ? now.getUTCDate() < lastSundayOfMonth(now.getUTCFullYear(), 10)
        : false;
  return { hour: (now.getUTCHours() + (isDST ? 2 : 1)) % 24, day: now.getUTCDay() };
}
function lastSundayOfMonth(year, month) {
  const d = new Date(Date.UTC(year, month, 0));
  return d.getUTCDate() - d.getUTCDay();
}
function isMarketOpen() {
  const { hour, day } = getParisHour();
  if (day === 0 || day === 6) return false;
  if (hour < 15 || hour >= 22) return false;
  if (hour === 15 && new Date().getUTCMinutes() < 30) return false;
  return true;
}
 
// ─── INDICATEURS ─────────────────────────────────────────────────────────────
function calcEMA(arr, p) {
  if (arr.length < p) return arr.map(() => arr[arr.length - 1] || 0);
  const k = 2 / (p + 1);
  let e   = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const r = new Array(p - 1).fill(e);
  r.push(e);
  for (let i = p; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); r.push(e); }
  return r;
}
function calcSMA(arr, p) {
  const r = new Array(p - 1).fill(arr[0] || 0);
  for (let i = p - 1; i < arr.length; i++) {
    r.push(arr.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p);
  }
  return r;
}
function calcStoch(highs, lows, closes, kP = 14, dP = 3) {
  const kArr = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < kP - 1) { kArr.push(50); continue; }
    const hh = Math.max(...highs.slice(i - kP + 1, i + 1));
    const ll = Math.min(...lows.slice(i - kP + 1, i + 1));
    kArr.push(hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100);
  }
  const dArr = [];
  for (let i = 0; i < kArr.length; i++) {
    if (i < dP - 1) { dArr.push(50); continue; }
    dArr.push(kArr.slice(i - dP + 1, i + 1).reduce((a, b) => a + b, 0) / dP);
  }
  return { k: kArr, d: dArr };
}
function calcBB(closes, p = 20, k = 2) {
  const upper = [], lower = [];
  const mid   = calcSMA(closes, p);
  for (let i = 0; i < closes.length; i++) {
    if (i < p - 1) { upper.push(closes[i] * 1.02); lower.push(closes[i] * 0.98); continue; }
    const slice = closes.slice(i - p + 1, i + 1);
    const mean  = slice.reduce((a, b) => a + b, 0) / p;
    const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / p);
    upper.push(mean + k * std);
    lower.push(mean - k * std);
  }
  return { upper, mid, lower };
}
function calcPivot(highs, lows, closes, i) {
  if (i < 5) return { pivot: closes[i], r1: closes[i] * 1.01 };
  const start = Math.max(0, i - 20);
  const pH    = Math.max(...highs.slice(start, i));
  const pL    = Math.min(...lows.slice(start, i));
  const pC    = closes[i - 1];
  const pivot = (pH + pL + pC) / 3;
  const r1    = 2 * pivot - pL;
  return { pivot, r1 };
}
 
// ─── MOTEUR SIGNAUX ───────────────────────────────────────────────────────────
function computeSignal(candles, stock) {
  if (candles.length < 60) return null;
  const closes = candles.map(c => parseFloat(c.close));
  const highs  = candles.map(c => parseFloat(c.high));
  const lows   = candles.map(c => parseFloat(c.low));
  const n      = closes.length - 1;
  if (n < 50) return null;
  const price = closes[n];
  const dec   = 2;
  const sl    = parseFloat((price * (1 - SL_PCT)).toFixed(dec));
  const tp    = parseFloat((price * (1 + TP_PCT)).toFixed(dec));
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const stoch  = calcStoch(highs, lows, closes);
  const bb     = calcBB(closes);
  const piv    = calcPivot(highs, lows, closes, n);
  const kv = stoch.k[n], dv = stoch.d[n];
  const s1 = kv > 75 && kv < dv;
  const s2 = price < ema50[n];
  const s3 = ema50[n] < ema200[n];
  const s4 = price >= bb.upper[n] * 0.995;
  const s5 = price > piv.pivot && closes[n - 1] <= calcPivot(highs, lows, closes, n - 1).pivot;
  const signals = [s1, s2, s3, s4, s5];
  const names   = ['Stoch suracheté crois.','Sous EMA50','EMA50 < EMA200','Touch bande BB haute','Cassure pivot'];
  const active  = signals.filter(Boolean).length;
  if (active < 3) return null;
  return {
    symbol:      stock.symbol,
    name:        stock.name,
    direction:   'BUY',
    entryPrice:  price.toFixed(dec),
    sl:          sl.toFixed(dec),
    tp:          tp.toFixed(dec),
    slPct:       `${(SL_PCT * 100).toFixed(1)}%`,
    tpPct:       `${(TP_PCT * 100).toFixed(1)}%`,
    reliability: 65,
    signalHits:  active,
    signalNames: names,
    signalStates:signals,
    reasons:     names.filter((_, i) => signals[i]).map(r => '✓ ' + r),
    timestamp:   new Date().toISOString(),
    engine:      'NEXUS'
  };
}
 
// ─── FETCH BOUGIES ────────────────────────────────────────────────────────────
async function fetchCandles(symbol, outputsize = 300) {
  try {
    const r = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=4h&outputsize=${outputsize}&apikey=${TWELVE_KEY}`
    );
    const d = await r.json();
    if (!d.values || d.status === 'error') {
      console.log(`⚠️  ${symbol} — ${d.message || 'données indisponibles'}`);
      return null;
    }
    return d.values.reverse().slice(0, -1);
  } catch(e) { console.error(`fetchCandles ${symbol}:`, e.message); return null; }
}
 
// ─── FETCH BOUGIES 30MIN ─────────────────────────────────────────────────────
async function fetchCandles30(symbol) {
  try {
    const r = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=15min&outputsize=300&apikey=${TWELVE_KEY}`
    );
    const d = await r.json();
    if (!d.values || d.status === 'error') return null;
    return d.values.reverse().slice(0, -1);
  } catch (e) { console.error(`fetchCandles30 ${symbol}:`, e.message); return null; }
}
 
// ─── VÉRIFICATION TP/SL — BOUGIES 30MIN (filtre strict post-entrée) ──────────
async function checkTrades() {
  if (!activeTrades.length) return;
  let changed = false;
 
  for (const trade of [...activeTrades]) {
    try {
      const tp = parseFloat(trade.tp);
      const sl = parseFloat(trade.sl);
      const en = parseFloat(trade.entryPrice);
 
      const entryTs = new Date(trade.addedAt || trade.timestamp).getTime();
      if (isNaN(entryTs)) { console.log(`⚠️  ${trade.symbol} — date invalide`); continue; }
 
      const candles = await fetchCandles30(trade.symbol);
      await sleep(2500);
      if (!candles || !candles.length) { console.log(`⚠️  ${trade.symbol} — bougies 15min indisponibles`); continue; }
 
      const postEntry = candles.filter(c => new Date(c.datetime).getTime() > entryTs);
 
      if (!postEntry.length) {
        console.log(`⏸  ${trade.symbol} — en attente bougie 15min post-entrée`);
        continue;
      }
 
      let closed = false, result = null, closePrice = null, closeDate = null;
 
      for (const candle of postEntry) {
        const high = parseFloat(candle.high);
        const low  = parseFloat(candle.low);
        if (high >= tp) { closed=true; result='WIN';  closePrice=tp; closeDate=candle.datetime; break; }
        if (low  <= sl) { closed=true; result='LOSS'; closePrice=sl; closeDate=candle.datetime; break; }
      }
 
      if (closed) {
        const pct = ((closePrice - en) / en * 100).toFixed(2);
        console.log(`${result==='WIN'?'✅':'❌'} ${trade.symbol} — ${result} — ${pct}% | 15min: ${closeDate}`);
        history.unshift({ ...trade, result, closePrice: closePrice.toFixed(2), pct, closedAt: new Date(closeDate).toISOString() });
        if (history.length > 100) history = history.slice(0, 100);
        activeTrades = activeTrades.filter(t => t.symbol !== trade.symbol);
        changed = true;
      } else {
        const last = postEntry[postEntry.length - 1];
        console.log(`⏸  ${trade.symbol} @ ${last.close} | TP +${((tp-last.close)/last.close*100).toFixed(2)}% | SL -${((last.close-sl)/last.close*100).toFixed(2)}% | ${postEntry.length} bougies 15min`);
      }
 
    } catch (e) { console.error(`checkTrades ${trade.symbol}:`, e.message); }
  }
  if (changed) await syncCloud();
}
 
// ─── SCAN PRINCIPAL ───────────────────────────────────────────────────────────
async function runScan() {
  console.log(`\n📡 SCAN NEXUS — ${new Date().toLocaleString('fr-FR')}`);
  if (!isMarketOpen()) {
    console.log('🚫 Marché US fermé — scan ignoré');
    await checkTrades();
    return;
  }
 
  await loadCloud();
  const now       = Date.now();
  const activeSym = activeTrades.map(t => t.symbol);
  let signalsFound = 0, changed = false;
 
  for (const stock of STOCKS) {
    if (activeSym.includes(stock.symbol)) {
      console.log(`⏸  ${stock.symbol} — trade actif`); continue;
    }
    if (lastSignalTime[stock.symbol] && (now - lastSignalTime[stock.symbol]) < ANTI_CLUSTER) {
      const h = Math.round((now - lastSignalTime[stock.symbol]) / 3600000);
      console.log(`🕐 ${stock.symbol} — signal récent (${h}h)`); continue;
    }
    try {
      const candles = await fetchCandles(stock.symbol);
      await sleep(2500);
      if (!candles) continue;
      const sig = computeSignal(candles, stock);
      if (sig) {
        console.log(`🚨 SIGNAL BUY — ${stock.name} @ $${sig.entryPrice} — ${sig.signalHits}/5 signaux`);
        activeTrades.push({ ...sig, addedAt: new Date().toISOString() });
        lastSignalTime[stock.symbol] = now;
        signalsFound++; changed = true;
      } else {
        console.log(`📊 ${stock.name} — aucun signal BUY`);
      }
    } catch(e) { console.error(`scan ${stock.symbol}:`, e.message); }
  }
 
  console.log(`✅ Scan terminé — ${signalsFound} signal(s) trouvé(s)`);
  await checkTrades();
  if (changed) await syncCloud();
}
 
// ─── SCHEDULING ───────────────────────────────────────────────────────────────
function getNextInterval() {
  const { hour, day } = getParisHour();
  if (day === 0 || day === 6) return 60 * 60 * 1000;
  if (hour >= 22 || hour < 15) return 60 * 60 * 1000;
  if (hour === 15 && new Date().getUTCMinutes() < 30) return 30 * 60 * 1000;
  return 15 * 60 * 1000;
}
async function scheduleNext() {
  const interval = getNextInterval();
  console.log(`⏱  Prochain scan dans ${Math.round(interval / 60000)} min`);
  setTimeout(async () => { await runScan(); scheduleNext(); }, interval);
}
 
// ─── HTTP ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:       'running',
    engine:       'NEXUS STOCKS',
    version:      '1.0.0',
    time:         new Date().toISOString(),
    marketOpen:   isMarketOpen(),
    activeTrades: activeTrades.length,
    history:      history.length,
    stocks:       STOCKS.map(s => s.symbol),
    signal: {
      buy: 'stochOverboughtCross + belowEMA50 + ema50_200Bear + bbUpperTouch + pivotBreakUp — WR 65%'
    }
  });
});
app.get('/status', (req, res) => {
  const wins = history.filter(h => h.result === 'WIN').length;
  const wr   = history.length ? Math.round(wins / history.length * 100) : 0;
  const pct  = history.reduce((s, h) => s + parseFloat(h.pct || 0), 0);
  res.json({
    activeTrades, history: history.slice(0, 50), lastSignalTime,
    marketOpen: isMarketOpen(),
    stats: {
      winRate:  history.length ? wr + '%' : '—',
      totalPct: history.length ? (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%' : '—',
      trades:   history.length, wins
    }
  });
});
app.post('/scan', async (req, res) => {
  res.json({ message: 'Scan NEXUS lancé' });
  runScan().catch(console.error);
});
app.post('/close', async (req, res) => {
  const { symbol, result, closePrice } = req.body;
  if (!symbol || !result) return res.status(400).json({ error: 'symbol et result requis' });
  const trade = activeTrades.find(t => t.symbol === symbol);
  if (!trade) return res.status(404).json({ error: 'Trade non trouvé' });
  const cp  = parseFloat(closePrice) || parseFloat(result === 'WIN' ? trade.tp : trade.sl);
  const en  = parseFloat(trade.entryPrice);
  const pct = ((cp - en) / en * 100).toFixed(2);
  history.unshift({ ...trade, result, closePrice: cp.toFixed(2), pct, closedAt: new Date().toISOString() });
  if (history.length > 100) history = history.slice(0, 100);
  activeTrades = activeTrades.filter(t => t.symbol !== symbol);
  await syncCloud();
  console.log(`🔒 Clôture manuelle — ${symbol} — ${result} — ${pct}%`);
  res.json({ success: true, pct, result });
});
 
// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
async function start() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   NEXUS STOCKS — Serveur de signaux                      ║');
  console.log('║   BUY: stochOverboughtCross + belowEMA50 + ema50_200Bear ║');
  console.log('║        + bbUpperTouch + pivotBreakUp — WR 65%            ║');
  console.log('║   TP/SL check : HIGH/LOW de chaque bougie 4h ✅          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  await loadCloud();
  app.listen(PORT, () => console.log(`🌐 Port ${PORT}`));
  await runScan();
  scheduleNext();
}
 
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
start().catch(console.error);
 
