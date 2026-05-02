'use strict';
const express = require('express');
const fetch   = require('node-fetch');
const app     = express();

// ─── VARIABLES D'ENVIRONNEMENT ────────────────────────────────────────────────
const TWELVE_KEY = process.env.TWELVE_DATA_API_KEY;
const JBIN_KEY   = process.env.JBIN_KEY;
const JBIN_ID    = process.env.JBIN_ID;
const PORT       = process.env.PORT || 3002;

if (!TWELVE_KEY || !JBIN_KEY || !JBIN_ID) {
  console.error('❌ Variables manquantes : TWELVE_DATA_API_KEY, JBIN_KEY, JBIN_ID');
  process.exit(1);
}

// ─── ACTIONS ─────────────────────────────────────────────────────────────────
const STOCKS = [
  { symbol: 'AAPL',  name: 'Apple',     spread: 0.0005 },
  { symbol: 'MSFT',  name: 'Microsoft', spread: 0.0005 },
  { symbol: 'NVDA',  name: 'NVIDIA',    spread: 0.0006 },
  { symbol: 'TSLA',  name: 'Tesla',     spread: 0.0008 },
  { symbol: 'AMZN',  name: 'Amazon',    spread: 0.0005 },
  { symbol: 'GOOGL', name: 'Google',    spread: 0.0005 },
  { symbol: 'META',  name: 'Meta',      spread: 0.0006 },
];

// ─── ÉTAT ────────────────────────────────────────────────────────────────────
let activeTrades   = [];
let history        = [];
let lastSignalTime = {};

const SL_PCT = 0.02; // SL = 2% du prix
const TP_PCT = 0.03; // TP = 3% du prix
const ANTI_CLUSTER = 24 * 60 * 60 * 1000; // 24h entre deux signaux sur la même action

// ─── CORS ─────────────────────────────────────────────────────────────────────
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
// Le marché US ouvre 15h30-22h Paris (heure d'été) / 16h30-23h (heure d'hiver)
function getParisHour() {
  const now   = new Date();
  // DST France : dernier dimanche de mars → dernier dimanche d'octobre
  const month = now.getUTCMonth() + 1; // 1-12
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
  if (day === 0 || day === 6) return false; // weekend
  // Marché US : 15h30-22h00 Paris (heure d'été)
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
  // Pivot calculé sur les 20 dernières bougies précédentes
  if (i < 5) return { pivot: closes[i], r1: closes[i] * 1.01 };
  const start = Math.max(0, i - 20);
  const pH    = Math.max(...highs.slice(start, i));
  const pL    = Math.min(...lows.slice(start, i));
  const pC    = closes[i - 1];
  const pivot = (pH + pL + pC) / 3;
  const r1    = 2 * pivot - pL;
  return { pivot, r1 };
}

// ─── SIGNAL BUY #1 ────────────────────────────────────────────────────────────
// stochOverboughtCross + belowEMA50 + ema50_200Bear + bbUpperTouch + pivotBreakUp
// Source : analyseur exhaustif 79M combos | WR: 65% | WF-min: 53% | PF: 2.73 | 237 trades
// Mode MAJ : 3 signaux sur 5 minimum requis
function computeSignal(candles, stock) {
  if (candles.length < 60) return null;

  const closes = candles.map(c => parseFloat(c.close));
  const highs  = candles.map(c => parseFloat(c.high));
  const lows   = candles.map(c => parseFloat(c.low));
  const n      = closes.length - 1;

  if (n < 50) return null;

  const price  = closes[n];
  const dec    = 2; // 2 décimales pour les actions US

  // Calcul SL et TP en dollars
  const sl = parseFloat((price * (1 - SL_PCT)).toFixed(dec));
  const tp = parseFloat((price * (1 + TP_PCT)).toFixed(dec));

  // Indicateurs
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const stoch  = calcStoch(highs, lows, closes);
  const bb     = calcBB(closes);
  const piv    = calcPivot(highs, lows, closes, n);

  // ─── 5 SIGNAUX DU COMBO BUY #1 ───────────────────────────────────────────
  const kv = stoch.k[n], dv = stoch.d[n];

  // Signal 1 : stochOverboughtCross — K > 75 ET K < D (zone surachetée avec croisement baissier)
  const s1 = kv > 75 && kv < dv;

  // Signal 2 : belowEMA50 — prix sous l'EMA50
  const s2 = price < ema50[n];

  // Signal 3 : ema50_200Bear — EMA50 < EMA200 (tendance long terme baissière)
  const s3 = ema50[n] < ema200[n];

  // Signal 4 : bbUpperTouch — prix touche la bande haute de Bollinger (±0.5%)
  const s4 = price >= bb.upper[n] * 0.995;

  // Signal 5 : pivotBreakUp — prix au-dessus du pivot et était en dessous
  const s5 = price > piv.pivot && closes[n - 1] <= calcPivot(highs, lows, closes, n - 1).pivot;

  const signals = [s1, s2, s3, s4, s5];
  const names   = [
    'Stoch surachet\u00e9 crois.',
    'Sous EMA50',
    'EMA50 < EMA200',
    'Touch bande BB haute',
    'Cassure pivot'
  ];
  const active  = signals.filter(Boolean).length;

  // Mode MAJ : 3/5 minimum
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
async function fetchCandles(symbol) {
  try {
    const r = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=4h&outputsize=300&apikey=${TWELVE_KEY}`
    );
    const d = await r.json();
    if (!d.values || d.status === 'error') {
      console.log(`⚠️  ${symbol} — ${d.message || 'données indisponibles'}`);
      return null;
    }
    return d.values.reverse().slice(0, -1); // chronologique, retire la bougie en cours
  } catch(e) { console.error(`fetchCandles ${symbol}:`, e.message); return null; }
}

// ─── VÉRIFICATION TP/SL ───────────────────────────────────────────────────────
async function checkTrades() {
  if (!activeTrades.length) return;
  let changed = false;

  for (const trade of [...activeTrades]) {
    try {
      const r = await fetch(
        `https://api.twelvedata.com/price?symbol=${trade.symbol}&apikey=${TWELVE_KEY}`
      );
      const d = await r.json();
      if (!d.price || d.status === 'error') { await sleep(2000); continue; }

      const cur = parseFloat(d.price);
      const tp  = parseFloat(trade.tp);
      const sl  = parseFloat(trade.sl);
      const en  = parseFloat(trade.entryPrice);
      const dec = 2;

      let closed = false, result = null, closePrice = null;
      if (cur >= tp)       { closed = true; result = 'WIN';  closePrice = tp; }
      else if (cur <= sl)  { closed = true; result = 'LOSS'; closePrice = sl; }

      if (closed) {
        const pct = ((closePrice - en) / en * 100).toFixed(2);
        console.log(`${result === 'WIN' ? '✅' : '❌'} ${trade.symbol} — ${result} — ${pct}%`);
        history.unshift({
          ...trade,
          result,
          closePrice: closePrice.toFixed(dec),
          pct,
          closedAt: new Date().toISOString()
        });
        if (history.length > 100) history = history.slice(0, 100);
        activeTrades = activeTrades.filter(t => t.symbol !== trade.symbol);
        changed = true;
      } else {
        const distTP = ((tp - cur) / cur * 100).toFixed(2);
        const distSL = ((cur - sl) / cur * 100).toFixed(2);
        console.log(`⏸  ${trade.symbol} @ ${cur} | TP à +${distTP}% | SL à -${distSL}%`);
      }
      await sleep(2000);
    } catch(e) { console.error(`checkTrades ${trade.symbol}:`, e.message); }
  }
  if (changed) await syncCloud();
}

// ─── SCAN PRINCIPAL ───────────────────────────────────────────────────────────
async function runScan() {
  console.log(`\n📡 SCAN NEXUS — ${new Date().toLocaleString('fr-FR')}`);

  if (!isMarketOpen()) {
    console.log('🚫 Marché US fermé — scan ignoré');
    await checkTrades(); // continue à surveiller les trades actifs
    return;
  }

  await loadCloud();

  const now         = Date.now();
  const activeSym   = activeTrades.map(t => t.symbol);
  let signalsFound  = 0;
  let changed       = false;

  for (const stock of STOCKS) {
    if (activeSym.includes(stock.symbol)) {
      console.log(`⏸  ${stock.symbol} — trade actif`);
      continue;
    }
    if (lastSignalTime[stock.symbol] && (now - lastSignalTime[stock.symbol]) < ANTI_CLUSTER) {
      const h = Math.round((now - lastSignalTime[stock.symbol]) / 3600000);
      console.log(`🕐 ${stock.symbol} — signal récent (${h}h)`);
      continue;
    }

    try {
      const candles = await fetchCandles(stock.symbol);
      await sleep(2500); // respect rate limit 8 req/min
      if (!candles) continue;

      const sig = computeSignal(candles, stock);
      if (sig) {
        console.log(`🚨 SIGNAL BUY — ${stock.name} @ $${sig.entryPrice} — ${sig.signalHits}/5 signaux`);
        console.log(`   ${sig.reasons.join(' · ')}`);
        activeTrades.push({ ...sig, addedAt: new Date().toISOString() });
        lastSignalTime[stock.symbol] = now;
        signalsFound++;
        changed = true;
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
  if (day === 0 || day === 6) return 60 * 60 * 1000; // weekend → 1h
  if (hour >= 22 || hour < 15) return 60 * 60 * 1000; // nuit → 1h
  if (hour === 15 && new Date().getUTCMinutes() < 30) return 30 * 60 * 1000;
  return 15 * 60 * 1000; // marché ouvert → 15 min
}

async function scheduleNext() {
  const interval = getNextInterval();
  console.log(`⏱  Prochain scan dans ${Math.round(interval / 60000)} min`);
  setTimeout(async () => { await runScan(); scheduleNext(); }, interval);
}

// ─── ENDPOINTS HTTP ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:      'running',
    engine:      'NEXUS STOCKS',
    version:     '1.0.0',
    time:        new Date().toISOString(),
    marketOpen:  isMarketOpen(),
    activeTrades:activeTrades.length,
    history:     history.length,
    stocks:      STOCKS.map(s => s.symbol),
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
    activeTrades,
    history: history.slice(0, 50),
    lastSignalTime,
    marketOpen: isMarketOpen(),
    stats: {
      winRate:   history.length ? wr + '%' : '—',
      totalPct:  history.length ? (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%' : '—',
      trades:    history.length,
      wins
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

  history.unshift({
    ...trade,
    result,
    closePrice: cp.toFixed(2),
    pct,
    closedAt: new Date().toISOString()
  });
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
  console.log('╚══════════════════════════════════════════════════════════╝');
  await loadCloud();
  app.listen(PORT, () => console.log(`🌐 Port ${PORT}`));
  await runScan();
  scheduleNext();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
start().catch(console.error);
