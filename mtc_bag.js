// ═══════════════════════════════════════════════════════════════
// MTC Strategy Suite — BAG Fund Module  (mtc_bag.js)
// Requires: marc_data.js, mtc_core.js, mtc_lab.js
//
// BAG Fund = Bitcoin And Gold. Live systematic fund.
// Mandate: monthly rebalance between BTC and PAXG using
// inverse-vol + Sortino + macro factor signal from excel model.
//
// FUNCTION INDEX:
// ─ DB Layer (ported from marc_nav.js) ──────────────────────────
//   navLoad / navSave           — local cache interface
//   dbLogin / dbVerifyToken     — Supabase auth
//   dbLoadFunds / dbCreateFund  — fund management
//   dbSetActiveFund             — switch active fund
//   dbLoadTrades / dbSaveTrade  — trade persistence
//   dbDeleteTrade               — remove trade
//   dbSavePrices / dbLoadPrices — price cache
//   dbLoadMessages / dbSaveMessage / dbClearMessages
//   dbSaveSnapshot              — NAV snapshot
//   dbInit                      — boot: restore session
// ─ Position Engine ─────────────────────────────────────────────
//   computePositions            — build positions from trades
// ─ Formatters ──────────────────────────────────────────────────
//   navFmt$ / navFmtQty / navPct
// ─ Regime ──────────────────────────────────────────────────────
//   getNavRegimeCoords / getModelWeights
//   renderNavRegimePanel / navComputeRegime / navAutoFillFRED
// ─ BAG Strategy Signal ─────────────────────────────────────────
//   bagComputeSignal            — BTC/Gold target weights
//   bagGetLivePrices            — fetch BTC + PAXG prices
// ─ Overview Page ───────────────────────────────────────────────
//   renderBagOverview           — card grid for Overview tab
// ─ NAV & Holdings Page ─────────────────────────────────────────
//   renderNavDashboard          — full NAV dashboard
//   renderNavCharts             — allocation/compare/PnL charts
//   renderAllAssetTable         — holdings + watchlist table
//   renderPriceTicker           — price pills strip
//   renderNavTradeLog           — compact trade log
//   renderNavTradeLogDrawer     — slide-up drawer
//   toggleTradeLog              — open/close drawer
// ─ Rebalance Signal Page ───────────────────────────────────────
//   renderBagSignal             — signal page card grid
// ─ Performance Page ────────────────────────────────────────────
//   renderBagPerformance        — performance charts + KPIs
// ─ Trade Modal ─────────────────────────────────────────────────
//   navOpenTradeModal / navCloseTradeModal / navSaveTrade
//   navDeleteTrade
// ─ CIO Agent Chat ──────────────────────────────────────────────
//   navChatSend / navChatQuick / navAgentProactive
//   navChatDispatch / buildAgentPrompt / navAgentClearChat
//   navChatAddMessage / navChatUpdateMessage
// ─ Export / Clear ──────────────────────────────────────────────
//   navExport / navClear
// ─ Alerts ──────────────────────────────────────────────────────
//   checkDriftAlert             — auto-fire drift warning
// ─ Markdown ────────────────────────────────────────────────────
//   renderMarkdown
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════
// STATE
// ═══════════════════════════════════════
var navState = {
  regimeCoords: null,
  liveCoords:   null
};

var _marcDB = {
  jwt:       null,
  activeFund: null,
  funds:     [],
  cache: {
    trades:      [],
    prices:      {},
    messages:    [],
    lastFetched: null,
    snapshots:   []
  }
};

// BAG strategy parameters (from Excel model)
const BAG_PARAMS = {
  targetVol:       0.15,
  factorVolBlend:  0.70,   // 70% factor-weighted, 30% pure vol
  ismWeight:       0.50,
  fedWeight:       0.20,
  mvrvWeight:      0.30,
  mgmtFeeMonthly:  0.00125,
  bcAdminFlat:     3850,
  cbCustody:       0.0000333,
  inceptionDate:   '2025-12-01',
  inceptionNAV:    1252527.65,
  inceptionUnits:  1
};

// Historical monthly data seeded from Excel (Dec 2024 → Mar 2026)
const BAG_HISTORY = [
  {date:'2024-12',btcPrice:151609.88,goldPrice:4248.11,btcRet:0.023747,goldRet:0.045878,btcWeight:null,goldWeight:null,fundRet:null,navAUD:null,navPerUnit:null},
  {date:'2025-01',btcPrice:165119.14,goldPrice:4503.29,btcRet:0.089105,goldRet:0.060071,btcWeight:0.234536,goldWeight:0.765464,fundRet:0.06688,navAUD:null,navPerUnit:1.0},
  {date:'2025-02',btcPrice:135958.91,goldPrice:4607.96,btcRet:-0.176601,goldRet:0.023242,btcWeight:0.214315,goldWeight:0.785685,fundRet:-0.019588,navAUD:null,navPerUnit:null},
  {date:'2025-03',btcPrice:131990.00,goldPrice:5045.14,btcRet:-0.029192,goldRet:0.094875,btcWeight:0.161799,goldWeight:0.838201,fundRet:0.074801,navAUD:null,navPerUnit:null},
  {date:'2025-04',btcPrice:147225.75,goldPrice:5122.24,btcRet:0.115431,goldRet:0.015282,btcWeight:0.143047,goldWeight:0.856953,fundRet:0.029608,navAUD:null,navPerUnit:null},
  {date:'2025-05',btcPrice:163035.02,goldPrice:5129.39,btcRet:0.107381,goldRet:0.001396,btcWeight:0.191641,goldWeight:0.808359,fundRet:0.021707,navAUD:null,navPerUnit:null},
  {date:'2025-06',btcPrice:162661.00,goldPrice:5049.38,btcRet:-0.002294,goldRet:-0.015598,btcWeight:0.183600,goldWeight:0.816400,fundRet:-0.013155,navAUD:null,navPerUnit:null},
  {date:'2025-07',btcPrice:180172.98,goldPrice:5125.55,btcRet:0.107659,goldRet:0.015085,btcWeight:0.187545,goldWeight:0.812455,fundRet:0.032447,navAUD:null,navPerUnit:null},
  {date:'2025-08',btcPrice:165881.98,goldPrice:5290.63,btcRet:-0.079318,goldRet:0.032207,btcWeight:0.180340,goldWeight:0.819660,fundRet:0.012094,navAUD:null,navPerUnit:null},
  {date:'2025-09',btcPrice:172513.00,goldPrice:5862.01,btcRet:0.039974,goldRet:0.107998,btcWeight:0.251811,goldWeight:0.748189,fundRet:0.090869,navAUD:null,navPerUnit:null},
  {date:'2025-10',btcPrice:167690.44,goldPrice:6111.87,btcRet:-0.027955,goldRet:0.042625,btcWeight:0.269040,goldWeight:0.730960,fundRet:0.023636,navAUD:null,navPerUnit:null},
  {date:'2025-11',btcPrice:138349.23,goldPrice:6471.92,btcRet:-0.174972,goldRet:0.058910,btcWeight:0.269592,goldWeight:0.730408,fundRet:-0.004143,navAUD:null,navPerUnit:null},
  {date:'2025-12',btcPrice:131200.61,goldPrice:6492.14,btcRet:-0.051671,goldRet:0.003124,btcWeight:0.227508,goldWeight:0.772492,fundRet:-0.009342,navAUD:1252527.65,navPerUnit:1.0},
  {date:'2026-01',btcPrice:113010.23,goldPrice:6945.44,btcRet:-0.138646,goldRet:0.069823,btcWeight:0.233675,goldWeight:0.766325,fundRet:0.021109,navAUD:1269339.50,navPerUnit:1.006243},
  {date:'2026-02',btcPrice:94139.82, goldPrice:7549.96,btcRet:-0.166980,goldRet:0.087038,btcWeight:0.258906,goldWeight:0.741094,fundRet:0.021272,navAUD:3481914.69,navPerUnit:1.029376},
  {date:'2026-03',btcPrice:104952.33,goldPrice:7025.06,btcRet:0.114856, goldRet:-0.069524,btcWeight:0.224654,goldWeight:0.775346,fundRet:-0.028859,navAUD:3383326.42,navPerUnit:0.997362},
];

// Compute cumulative NAV/unit from inception
(function() {
  let cum = 1.0;
  const inceptionIdx = BAG_HISTORY.findIndex(r => r.date === '2025-12');
  for (let i = inceptionIdx; i < BAG_HISTORY.length; i++) {
    const r = BAG_HISTORY[i];
    if (r.fundRet !== null) cum *= (1 + r.fundRet);
    if (r.navPerUnit === null) r.navPerUnit = cum;
  }
})();

var navChatHistory = [];
var tradeLogOpen   = false;

// ═══════════════════════════════════════
// DB LAYER — ported verbatim from marc_nav.js
// ═══════════════════════════════════════

function navLoad() {
  const c = _marcDB.cache;
  return {
    trades:      c.trades || [],
    prices:      c.prices || {},
    lastFetched: c.lastFetched,
    fundId:      _marcDB.activeFund ? _marcDB.activeFund.id : null
  };
}

function navSave(data) {
  if (data.trades      !== undefined) _marcDB.cache.trades      = data.trades;
  if (data.prices      !== undefined) _marcDB.cache.prices      = data.prices;
  if (data.lastFetched !== undefined) _marcDB.cache.lastFetched = data.lastFetched;
  try { localStorage.setItem('marc_nav_cache', JSON.stringify(_marcDB.cache)); } catch(e) {}
}

async function dbLogin(email, password) {
  const r = await fetch(_api() + '/auth/login', {
    method:  'POST',
    headers: {'Content-Type':'application/json','Origin':'https://mtc-ash.github.io'},
    body:    JSON.stringify({email, password})
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  const token = d.token || d.access_token;
  _marcDB.jwt = token;
  try { localStorage.setItem('marc_jwt', token); } catch(e) {}
  return d;
}

async function dbVerifyToken(token) {
  _marcDB.jwt = token;
  const r = await fetch(_api() + '/auth/verify', {
    method:  'POST',
    headers: {'Content-Type':'application/json','Origin':'https://mtc-ash.github.io'},
    body:    JSON.stringify({token})
  });
  const d = await r.json();
  if (!d.valid) { _marcDB.jwt = null; throw new Error('Token invalid'); }
  return d.user;
}

async function dbLoadFunds() {
  const r     = await fetch(_api() + '/db/funds', {headers: _authHeaders()});
  const funds = await r.json();
  if (funds.error) throw new Error(funds.error);
  _marcDB.funds = Array.isArray(funds) ? funds : [];
  return _marcDB.funds;
}

async function dbCreateFund(name, type, color) {
  const r = await fetch(_api() + '/db/funds', {
    method:  'POST',
    headers: _authHeaders(),
    body:    JSON.stringify({name, type, color: color || '#00C97A'})
  });
  const d    = await r.json();
  if (d.error) throw new Error(d.error);
  const fund = Array.isArray(d) ? d[0] : d;
  _marcDB.funds.push(fund);
  return fund;
}

async function dbSetActiveFund(fund) {
  _marcDB.activeFund = fund;
  try { localStorage.setItem('marc_active_fund', JSON.stringify(fund)); } catch(e) {}
  await dbLoadTrades(fund.id);
  await dbLoadMessages(fund.id);
}

async function dbLoadTrades(fundId) {
  if (!_marcDB.jwt) return;
  const fid = fundId || (_marcDB.activeFund ? _marcDB.activeFund.id : null);
  if (!fid) return;
  const r      = await fetch(_api() + '/db/trades?fund_id=' + fid, {headers: _authHeaders()});
  const trades = await r.json();
  if (!Array.isArray(trades)) return;
  _marcDB.cache.trades = trades.map(t => ({
    id:        t.id,
    asset:     t.asset,
    direction: t.direction,
    date:      t.date,
    qty:       parseFloat(t.qty),
    price:     parseFloat(t.price),
    notes:     t.notes || '',
    ts:        new Date(t.created_at).getTime()
  }));
  try { localStorage.setItem('marc_nav_cache', JSON.stringify(_marcDB.cache)); } catch(e) {}
}

async function dbSaveTrade(trade) {
  if (!_marcDB.jwt || !_marcDB.activeFund) {
    _marcDB.cache.trades.push(trade);
    navSave({trades: _marcDB.cache.trades});
    return trade;
  }
  const r = await fetch(_api() + '/db/trades', {
    method:  'POST',
    headers: _authHeaders(),
    body:    JSON.stringify({
      fund_id:   _marcDB.activeFund.id,
      asset:     trade.asset,
      direction: trade.direction,
      date:      trade.date,
      qty:       trade.qty,
      price:     trade.price,
      notes:     trade.notes || ''
    })
  });
  const d     = await r.json();
  if (d.error) throw new Error(d.error);
  const saved = Array.isArray(d) ? d[0] : d;
  const norm  = {
    id:        saved.id,
    asset:     saved.asset,
    direction: saved.direction,
    date:      saved.date,
    qty:       parseFloat(saved.qty),
    price:     parseFloat(saved.price),
    notes:     saved.notes || '',
    ts:        new Date(saved.created_at).getTime()
  };
  _marcDB.cache.trades.push(norm);
  try { localStorage.setItem('marc_nav_cache', JSON.stringify(_marcDB.cache)); } catch(e) {}
  return norm;
}

async function dbDeleteTrade(id) {
  _marcDB.cache.trades = _marcDB.cache.trades.filter(t => t.id !== id);
  navSave({trades: _marcDB.cache.trades});
  if (!_marcDB.jwt) return;
  await fetch(_api() + '/db/trades/' + id, {method:'DELETE', headers: _authHeaders()});
}

async function dbSavePrices(prices) {
  Object.assign(_marcDB.cache.prices, prices);
  _marcDB.cache.lastFetched = new Date().toISOString();
  navSave({prices: _marcDB.cache.prices, lastFetched: _marcDB.cache.lastFetched});
  if (!_marcDB.jwt) return;
  const rows = Object.entries(prices).map(([asset, p]) => ({
    asset,
    price:       p.price,
    change_24h:  p.change24h  || 0,
    change_7d:   p.change7d   || 0,
    market_cap:  p.marketCap  || 0,
    volume_24h:  p.volume24h  || 0,
    source:      p.source     || '',
    updated_at:  new Date().toISOString()
  }));
  if (rows.length) {
    await fetch(_api() + '/db/prices', {
      method: 'POST', headers: _authHeaders(), body: JSON.stringify(rows)
    });
  }
}

async function dbLoadPrices() {
  if (!_marcDB.jwt) return;
  const r    = await fetch(_api() + '/db/prices', {headers: _authHeaders()});
  const rows = await r.json();
  if (!Array.isArray(rows)) return;
  rows.forEach(row => {
    _marcDB.cache.prices[row.asset] = {
      price:     parseFloat(row.price),
      change24h: parseFloat(row.change_24h) || 0,
      change7d:  parseFloat(row.change_7d)  || 0,
      marketCap: parseFloat(row.market_cap) || 0,
      volume24h: parseFloat(row.volume_24h) || 0,
      source:    row.source || 'db',
      updatedAt: row.updated_at
    };
  });
  _marcDB.cache.lastFetched = rows.length ? rows[0].updated_at : null;
}

async function dbLoadMessages(fundId) {
  if (!_marcDB.jwt) return;
  const fid = fundId || (_marcDB.activeFund ? _marcDB.activeFund.id : null);
  if (!fid) return;
  const r    = await fetch(_api() + '/db/messages?fund_id=' + fid + '&limit=100', {headers: _authHeaders()});
  const msgs = await r.json();
  if (!Array.isArray(msgs)) return;
  _marcDB.cache.messages = msgs.map(m => ({
    id:      m.id,
    role:    m.role,
    content: m.content,
    ts:      new Date(m.created_at).getTime()
  }));
}

async function dbSaveMessage(role, content, fundId) {
  const fid = fundId || (_marcDB.activeFund ? _marcDB.activeFund.id : null);
  const msg = {role, content, ts: Date.now()};
  if (!fid || !_marcDB.jwt) {
    _marcDB.cache.messages.push(msg);
    return msg;
  }
  const r    = await fetch(_api() + '/db/messages', {
    method:  'POST',
    headers: _authHeaders(),
    body:    JSON.stringify({fund_id: fid, role, content})
  });
  const d    = await r.json();
  const saved = Array.isArray(d) ? d[0] : d;
  msg.id = saved.id;
  _marcDB.cache.messages.push(msg);
  return msg;
}

async function dbClearMessages(fundId) {
  const fid = fundId || (_marcDB.activeFund ? _marcDB.activeFund.id : null);
  _marcDB.cache.messages = [];
  if (!fid || !_marcDB.jwt) return;
  await fetch(_api() + '/db/messages?fund_id=' + fid, {method:'DELETE', headers: _authHeaders()});
}

async function dbSaveSnapshot(nav, cost, pnl, regime) {
  const fid = _marcDB.activeFund ? _marcDB.activeFund.id : null;
  if (!fid || !_marcDB.jwt) return;
  await fetch(_api() + '/db/snapshot', {
    method:  'POST',
    headers: _authHeaders(),
    body:    JSON.stringify({fund_id: fid, nav, total_cost: cost, pnl, regime: regime || ''})
  });
}

async function dbInit() {
  try {
    const savedJwt   = localStorage.getItem('marc_jwt');
    const savedFund  = localStorage.getItem('marc_active_fund');
    const savedCache = localStorage.getItem('marc_nav_cache');
    if (savedCache) {
      const c = JSON.parse(savedCache);
      _marcDB.cache.trades      = c.trades      || [];
      _marcDB.cache.prices      = c.prices      || {};
      _marcDB.cache.lastFetched = c.lastFetched || null;
    }
    if (savedFund) _marcDB.activeFund = JSON.parse(savedFund);
    if (savedJwt) {
      try {
        await dbVerifyToken(savedJwt);
        await dbLoadFunds();
        if (_marcDB.activeFund) {
          await dbLoadTrades(_marcDB.activeFund.id);
          await dbLoadPrices();
          await dbLoadMessages(_marcDB.activeFund.id);
        }
        return true;
      } catch(e) {
        localStorage.removeItem('marc_jwt');
        _marcDB.jwt = null;
      }
    }
  } catch(e) { console.warn('dbInit error:', e); }
  return false;
}

// ═══════════════════════════════════════
// POSITION ENGINE
// ═══════════════════════════════════════
function computePositions(trades) {
  const pos = {};
  trades.forEach(t => {
    if (!pos[t.asset]) pos[t.asset] = {qty: 0, costBasis: 0};
    const p = pos[t.asset];
    if (t.direction === 'buy') {
      const newQty = p.qty + t.qty;
      p.costBasis  = newQty > 0 ? (p.costBasis * p.qty + t.price * t.qty) / newQty : 0;
      p.qty        = newQty;
    } else {
      p.qty = Math.max(0, p.qty - t.qty);
    }
  });
  Object.keys(pos).forEach(k => { if (pos[k].qty <= 0.000001) delete pos[k]; });
  return pos;
}

// ═══════════════════════════════════════
// FORMATTERS
// ═══════════════════════════════════════
function navFmt$(v) {
  if (isNaN(v) || v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return (v < 0 ? '-' : '') + '$' + (abs/1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (v < 0 ? '-' : '') + '$' + (abs/1e3).toFixed(1) + 'k';
  return (v < 0 ? '-' : '') + '$' + abs.toFixed(2);
}
function navFmtQty(v) {
  if (v >= 1e6)  return (v/1e6).toFixed(2) + 'M';
  if (v >= 1e3)  return (v/1e3).toFixed(2) + 'k';
  if (v < 0.001) return v.toFixed(6);
  if (v < 1)     return v.toFixed(4);
  return v.toFixed(2);
}
function navPct(v, dec) { return (v >= 0 ? '+' : '') + (v*100).toFixed(dec || 1) + '%'; }

// ═══════════════════════════════════════
// REGIME COORDS
// ═══════════════════════════════════════
function getNavRegimeCoords() {
  if (navState.liveCoords) return navState.liveCoords;
  if (typeof quarterly !== 'undefined' && typeof endDate !== 'undefined') {
    const qKeys = Object.keys(quarterly).filter(qk => qk <= endDate).sort();
    if (qKeys.length) return quarterly[qKeys[qKeys.length-1]];
  }
  return null;
}

function getModelWeights() {
  const q = getNavRegimeCoords();
  if (!q) return {};
  const lastQk = Object.keys(window.RAW.quarterly).sort().pop();
  const avail  = window.RAW.assets
    .filter(a => a.first_data && a.first_data <= lastQk)
    .map(a => a.asset);
  const holdings = computeWeights(q.rx, q.ry, avail, params.alpha, params.mcbeta, params.n);
  const weights  = {};
  holdings.forEach(h => { weights[h.asset] = h; });
  return weights;
}

function renderNavRegimePanel() {
  const q = getNavRegimeCoords();
  if (!q) return;
  const pill  = document.getElementById('nav-regime-pill');
  const coord = document.getElementById('nav-regime-coord');
  const src   = document.getElementById('nav-regime-source');
  if (pill)  { pill.textContent = q.quadrant; pill.className = 'rpill rpill-' + q.quadrant.charAt(0); }
  if (coord) coord.textContent = '(' + q.rx.toFixed(4) + ', ' + q.ry.toFixed(4) + ')';
  if (src)   src.textContent   = navState.liveCoords ? 'Live calc' : 'Last backtest quarter';
  const mList  = document.getElementById('nav-model-list');
  const sorted = Object.values(getModelWeights()).sort((a, b) => b.weight - a.weight);
  if (!mList) return;
  if (!sorted.length) { mList.innerHTML = '<div style="color:var(--subtle);font-size:10px;padding:8px;">Run backtest first</div>'; return; }
  mList.innerHTML = sorted.map((h, i) => {
    const tc   = {Equity:'#4D9FFF',ETF:'#A78BFA',Crypto:'#FFB020',Commodity:'#00C97A'}[h.type] || '#888';
    const barW = Math.min(100, Math.round(h.weight * 100 * 3));
    return `<div class="nav-model-row">
      <span class="nav-model-rank">${i+1}</span>
      <span class="nav-model-name">${h.asset}</span>
      <span style="font-size:9px;color:${tc};font-family:var(--mono);margin-right:4px;">${h.type.slice(0,3)}</span>
      <div class="nav-model-bar-wrap"><div class="nav-model-bar" style="width:${barW}%;background:${tc};"></div></div>
      <span class="nav-model-pct" style="color:${tc};">${(h.weight*100).toFixed(1)}%</span>
    </div>`;
  }).join('');
}

function navComputeRegime() {
  const get = id => parseFloat(document.getElementById(id)?.value);
  const gdp=get('nav-rc-gdp'), pmi=get('nav-rc-pmi'), unemp=get('nav-rc-unemp'),
        retail=get('nav-rc-retail'), cpi=get('nav-rc-cpi'), pce=get('nav-rc-pce');
  if ([gdp,pmi,unemp,retail,cpi,pce].some(isNaN)) { alert('Fill in all 6 indicators.'); return; }
  const h = Math.max(-7, Math.min(7, (gdp*100-1)*3));
  const i = Math.max(-7, Math.min(7, (pmi-50)*0.65));
  const j = Math.max(-7, Math.min(7, (unemp-4.5)*2.8*-1));
  const k = Math.max(-7, Math.min(7, (retail-0.3)*2));
  const l = Math.max(-7, Math.min(7, (cpi-2.5)*2));
  const m = Math.max(-7, Math.min(7, (pce-2)*2));
  const x = (h*2 + i*3 + j*2 + k*1) / 8;
  const y = (l*3 + m*2) / 5;
  const quad = x>=0&&y<0?'Expansion':x<0&&y<0?'Deflation':x>=0&&y>=0?'Reflation':'Stagflation';
  navState.liveCoords = {rx: parseFloat(x.toFixed(4)), ry: parseFloat(y.toFixed(4)), quadrant: quad};
  const RC  = {Expansion:'#00C97A',Deflation:'#4D9FFF',Reflation:'#FFB020',Stagflation:'#FF4D6D'};
  const res = document.getElementById('nav-rc-result');
  if (res) res.innerHTML = `
    <div style="margin-top:8px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);">
      <div style="font-family:var(--mono);font-size:9px;color:var(--subtle);margin-bottom:4px;">RESULT</div>
      <div style="font-size:14px;font-weight:700;color:${RC[quad]||'#888'};margin-bottom:2px;">${quad}</div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--muted);">X=${x.toFixed(4)} | Y=${y.toFixed(4)}</div>
    </div>`;
  renderNavRegimePanel();
  renderBagSignalKPIs();
}

async function navAutoFillFRED() {
  const btn = document.getElementById('nav-fred-btn');
  const res = document.getElementById('nav-rc-result');
  if (btn) { btn.textContent = '⟳ Loading…'; btn.disabled = true; }
  try {
    const r = await fetch(_api() + '/fred');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const setF = (id, val, dec) => {
      const el = document.getElementById(id);
      if (el && val != null && !isNaN(val)) el.value = parseFloat(val).toFixed(dec || 2);
    };
    setF('nav-rc-gdp',    d.gdp   != null ? d.gdp/100   : null, 4);
    setF('nav-rc-pmi',    d.pmi,    1);
    setF('nav-rc-unemp',  d.unemp,  1);
    setF('nav-rc-retail', d.retail != null ? d.retail/100 : null, 4);
    setF('nav-rc-cpi',    d.cpi,    2);
    setF('nav-rc-pce',    d.pce,    2);
    const dates = ['gdp','pmi','unemp','retail','cpi','pce']
      .filter(k => d[k+'_date'])
      .map(k => k.toUpperCase() + ':' + d[k+'_date'].slice(0,7)).join('  ');
    if (res) res.innerHTML = `<div style="margin-top:6px;padding:6px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);font-family:var(--mono);font-size:9px;color:var(--subtle);">FRED loaded<br>${dates}<br><span style="color:var(--amber);">PMI is estimated — enter actual if available</span></div>`;
    navComputeRegime();
  } catch(e) {
    if (res) res.innerHTML = `<div style="margin-top:6px;padding:6px 8px;background:var(--red-dim);border:1px solid var(--red);border-radius:var(--r-sm);font-family:var(--mono);font-size:9px;color:var(--red);">FRED failed: ${e.message}</div>`;
  }
  if (btn) { btn.textContent = '↻ FRED'; btn.disabled = false; }
}

// ═══════════════════════════════════════
// BAG STRATEGY SIGNAL ENGINE
// Implements the Excel model:
// BTC Score = ISM_change*0.5 + Fed_change*0.2 + MVRV*0.3
// Final weight = 70% factor-score blend + 30% inverse-vol
// ═══════════════════════════════════════
function bagComputeSignal({ism, mvrv, fedRate, ismPrev, fedPrev, btcVol12m, goldVol12m, btcSortino, goldSortino}) {
  // Standardised BTC score (ISM change + Fed change + MVRV Z)
  const ismChange = ismPrev != null ? (ism - ismPrev) / 50 : 0;
  const fedChange = fedPrev != null ? (fedRate - fedPrev) / fedPrev : 0;
  const mvrvScore = Math.max(0, Math.min(1, 1 - (mvrv / 3)));   // low MVRV = bullish BTC

  // Clamp each factor to [-1, 1] then weight
  const btcScore = Math.max(-1, Math.min(1,
    ismChange * BAG_PARAMS.ismWeight * 10 +
    (-fedChange) * BAG_PARAMS.fedWeight * 10 +   // rising rates = bearish BTC
    mvrvScore * BAG_PARAMS.mvrvWeight
  ));

  // Inverse volatility weights
  const invBtc  = btcVol12m  > 0 ? 1 / btcVol12m  : 1;
  const invGold = goldVol12m > 0 ? 1 / goldVol12m : 1;
  const invSum  = invBtc + invGold;
  const wBtcVol  = invBtc  / invSum;
  const wGoldVol = invGold / invSum;

  // Sortino-blended weights (if sortino available)
  let wBtcSort = wBtcVol, wGoldSort = wGoldVol;
  if (btcSortino != null && goldSortino != null) {
    const sBtc  = Math.max(0, btcSortino);
    const sGold = Math.max(0, goldSortino);
    const invSBtc  = sBtc  > 0 ? 1/sBtc  : 0;
    const invSGold = sGold > 0 ? 1/sGold : 0;
    const sSum = invSBtc + invSGold;
    if (sSum > 0) {
      wBtcSort  = invSBtc  / sSum;
      wGoldSort = invSGold / sSum;
    }
  }

  // Pure vol blend = 50% inverse-vol + 50% sortino-vol
  const wBtcPureVol  = 0.5 * wBtcVol  + 0.5 * wBtcSort;
  const wGoldPureVol = 0.5 * wGoldVol + 0.5 * wGoldSort;

  // Factor score blend: btcScore drives BTC tilt
  const blend     = BAG_PARAMS.factorVolBlend;
  // BTC factor tilt: 0% BTC at btcScore=-1, 100% BTC at btcScore=+1, normalised
  const factorBtc = Math.max(0, Math.min(1, (btcScore + 1) / 2));
  const wBtcFinal  = blend * factorBtc + (1-blend) * wBtcPureVol;
  const wGoldFinal = 1 - wBtcFinal;

  return {
    btcWeight:  +wBtcFinal.toFixed(4),
    goldWeight: +wGoldFinal.toFixed(4),
    btcScore:   +btcScore.toFixed(4),
    btcVolWeight:  +wBtcVol.toFixed(4),
    goldVolWeight: +wGoldVol.toFixed(4)
  };
}

// Get latest BAG history row
function bagLatestHistory() {
  return BAG_HISTORY[BAG_HISTORY.length - 1];
}

// Compute current signal from latest history
function bagCurrentSignal() {
  const latest = bagLatestHistory();
  const prev   = BAG_HISTORY[BAG_HISTORY.length - 2];
  return bagComputeSignal({
    ism:       52.4,   // latest known — will be overridden by live calc if available
    mvrv:      latest.navPerUnit ? 0.48 : 1.0,
    fedRate:   0.0375,
    ismPrev:   50.3,
    fedPrev:   0.0375,
    btcVol12m:  0.364,
    goldVol12m: 0.133,
    btcSortino:  0.345,
    goldSortino: 0.434
  });
}

// ═══════════════════════════════════════
// LIVE PRICE FETCH
// ═══════════════════════════════════════
async function navFetchPrices() {
  const btn       = document.getElementById('nav-price-btn');
  const updatedEl = document.getElementById('nav-kpi-updated');
  if (btn) { btn.textContent = '↻ Fetching…'; btn.disabled = true; }
  const allAssets = window.RAW ? window.RAW.assets.map(a => a.asset) : [];
  let result;
  try {
    const r = await fetch(_api() + '/prices?assets=' + allAssets.join(','));
    result  = await r.json();
    if (result.prices && Object.keys(result.prices).length) {
      const d = navLoad();
      if (!d.prices) d.prices = {};
      Object.assign(d.prices, result.prices);
      d.lastFetched = new Date().toISOString();
      navSave(d);
    }
  } catch(e) { console.error('Price fetch error:', e.message); }
  if (result && result.prices && Object.keys(result.prices).length) {
    await dbSavePrices(result.prices);
  }
  if (btn) { btn.textContent = '↻ Prices'; btn.disabled = false; }
  renderNavDashboard();
  renderBagOverview();
  checkDriftAlert();
}

// ═══════════════════════════════════════
// OVERVIEW PAGE
// ═══════════════════════════════════════
function renderBagOverview() {
  const data      = navLoad();
  const positions = computePositions(data.trades);
  const prices    = data.prices || {};

  // Compute current portfolio values
  let totalValue = 0, totalCost = 0;
  Object.keys(positions).forEach(asset => {
    const p  = positions[asset];
    const cp = prices[asset] ? prices[asset].price : p.costBasis;
    totalValue += p.qty * cp;
    totalCost  += p.qty * p.costBasis;
  });
  const totalPnl = totalValue - totalCost;
  const totalRet = totalCost > 0 ? totalPnl / totalCost : 0;

  // Latest history
  const latest    = bagLatestHistory();
  const signal    = bagCurrentSignal();

  // Model drift
  const modelW = {'Bitcoin': signal.btcWeight, 'PAX Gold': signal.goldWeight};
  let drift = 0;
  if (totalValue > 0) {
    Object.entries(modelW).forEach(([asset, mw]) => {
      const p      = positions[asset];
      const cp     = p ? (prices[asset] ? prices[asset].price : p.costBasis) : 0;
      const actual = p ? p.qty * cp / totalValue : 0;
      drift       += Math.abs(actual - mw);
    });
  }

  // NAV per unit
  const unitsIssued = 1; // simplification for v1 — unit tracking in Phase 2
  const navPerUnit  = latest.navPerUnit || 1;

  // Update topbar KPIs
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const cls = (id, c) => { const el = document.getElementById(id); if (el) el.className = 'kpi-v ' + c; };
  set('bag-kpi-nav',  totalValue > 0 ? navFmt$(totalValue) : navFmt$(BAG_PARAMS.inceptionNAV));
  set('bag-kpi-unit', navPerUnit.toFixed(4));
  set('bag-kpi-unit-sub', navPct(navPerUnit - 1, 2) + ' since inception');

  // vs BTC
  const btcInception = BAG_HISTORY[BAG_HISTORY.findIndex(r => r.date === '2025-12')]?.btcPrice || 131200;
  const btcNow = prices['Bitcoin']?.price || latest.btcPrice;
  const vsBtc  = (btcNow / btcInception) - navPerUnit;
  set('bag-kpi-vsbtc', navPct(navPerUnit - 1 - (btcNow/btcInception - 1), 1));
  cls('bag-kpi-vsbtc', vsBtc >= 0 ? 'g' : 'r');
  set('bag-kpi-vsbtc-sub', vsBtc >= 0 ? 'outperforming' : 'underperforming');

  // vs Gold
  const goldInception = BAG_HISTORY[BAG_HISTORY.findIndex(r => r.date === '2025-12')]?.goldPrice || 6492;
  const goldNow  = prices['PAX Gold']?.price || latest.goldPrice;
  const vsGold   = navPerUnit - 1 - (goldNow/goldInception - 1);
  set('bag-kpi-vsgold', navPct(vsGold, 1));
  cls('bag-kpi-vsgold', vsGold >= 0 ? 'g' : 'r');
  set('bag-kpi-vsgold-sub', vsGold >= 0 ? 'outperforming' : 'underperforming');

  // Drift
  const driftPct = (drift * 100).toFixed(1) + '%';
  set('bag-kpi-drift', driftPct);
  cls('bag-kpi-drift', drift > 0.10 ? 'r' : drift > 0.05 ? 'a' : 'g');
  set('bag-kpi-drift-sub', drift > 0.05 ? '⚠ rebalance due' : 'within tolerance');

  // Last rebalance
  const lastTrade = data.trades.sort((a, b) => b.ts - a.ts)[0];
  if (lastTrade) {
    set('bag-kpi-rebal', lastTrade.date.slice(0,7));
    const days = Math.floor((Date.now() - lastTrade.ts) / 86400000);
    set('bag-kpi-rebal-sub', days + ' days ago');
  } else {
    set('bag-kpi-rebal', 'None');
    set('bag-kpi-rebal-sub', 'no trades recorded');
  }

  // Card grid
  const grid = document.getElementById('bag-overview-grid');
  if (!grid) return;

  // Build NAV per unit history for sparkline
  const histRows = BAG_HISTORY.filter(r => r.navPerUnit !== null && r.date >= '2025-12');
  const navSeries = histRows.map(r => r.navPerUnit);
  const dateSeries = histRows.map(r => r.date);
  const minNPU = Math.min(...navSeries) * 0.995;
  const maxNPU = Math.max(...navSeries) * 1.005;

  grid.innerHTML = `
    <!-- Holdings card -->
    <div class="card">
      <div class="card-hdr">
        <span class="card-title">Holdings</span>
        <span class="card-meta" style="color:var(--green);">LIVE PRICES</span>
      </div>
      <div class="card-body">
        ${['Bitcoin','PAX Gold'].map(asset => {
          const p  = positions[asset];
          const pd = prices[asset];
          const cp = pd ? pd.price : (p ? p.costBasis : null);
          const wt = p && totalValue > 0 && cp ? (p.qty * cp / totalValue * 100).toFixed(1) + '%' : '—';
          const icon = asset === 'Bitcoin' ? '₿' : '◈';
          const color = asset === 'Bitcoin' ? 'var(--amber)' : 'var(--green)';
          const bg    = asset === 'Bitcoin' ? 'rgba(255,176,32,0.1)' : 'rgba(0,201,122,0.1)';
          return `
            <div style="display:grid;grid-template-columns:36px 1fr auto auto;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--border);">
              <div style="width:36px;height:36px;border-radius:8px;background:${bg};display:flex;align-items:center;justify-content:center;font-size:16px;">${icon}</div>
              <div>
                <div style="font-size:12px;font-weight:600;color:var(--text);">${asset}</div>
                <div style="font-family:var(--mono);font-size:9px;color:var(--subtle);">${p ? navFmtQty(p.qty) + (asset==='Bitcoin'?' BTC':' PAXG') : '—'}</div>
              </div>
              <div style="text-align:right;">
                <div style="font-family:var(--mono);font-size:12px;color:var(--text);">${cp ? navFmt$(p ? p.qty*cp : 0) : '—'}</div>
                <div style="font-family:var(--mono);font-size:9px;color:var(--subtle);">${cp ? '$'+cp.toLocaleString('en-AU',{maximumFractionDigits:2}) : '—'}</div>
              </div>
              <div style="font-family:var(--mono);font-size:13px;font-weight:500;color:${color};min-width:50px;text-align:right;">${wt}</div>
            </div>`;
        }).join('')}
        <div id="bag-overview-nav-chart" style="height:80px;margin-top:10px;"></div>
      </div>
    </div>

    <!-- Signal card -->
    <div class="card">
      <div class="card-hdr">
        <span class="card-title">Rebalance Signal</span>
        <span class="card-meta">MODEL OUTPUT</span>
      </div>
      <div class="card-body">
        ${[['Bitcoin', signal.btcWeight, 'var(--amber)'], ['PAX Gold', signal.goldWeight, 'var(--green)']].map(([name, wt, color]) => {
          const p        = positions[name];
          const cp       = prices[name]?.price || (p ? p.costBasis : 0);
          const actual   = p && totalValue > 0 && cp ? p.qty * cp / totalValue : 0;
          const delta    = actual - wt;
          const absDelta = Math.abs(delta * 100).toFixed(1);
          const action   = delta > 0.01 ? `sell $${Math.abs(delta * totalValue).toFixed(0)}` : delta < -0.01 ? `buy $${Math.abs(delta * totalValue).toFixed(0)}` : 'on target';
          return `
            <div style="margin-bottom:14px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
                <span style="font-size:11px;font-weight:500;color:var(--muted);">${name}</span>
                <span style="font-family:var(--mono);font-size:14px;font-weight:500;color:${color};">${(wt*100).toFixed(1)}%</span>
              </div>
              <div style="height:8px;background:var(--surface2);border-radius:4px;overflow:hidden;margin-bottom:4px;">
                <div style="width:${(wt*100).toFixed(1)}%;height:100%;background:${color};border-radius:4px;"></div>
              </div>
              <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:9px;color:var(--subtle);">
                <span>actual ${(actual*100).toFixed(1)}%</span>
                <span style="color:${Math.abs(delta)>0.01?(delta>0?'var(--red)':'var(--green)'):'var(--subtle)'};">${action}</span>
              </div>
            </div>`;
        }).join('')}
        <div style="padding:10px;background:var(--surface2);border-radius:var(--r-sm);border:1px solid var(--border);margin-top:4px;">
          <div style="font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">BTC Score</div>
          <div style="font-family:var(--mono);font-size:20px;font-weight:500;color:${signal.btcScore>=0?'var(--green)':'var(--red)'};">${signal.btcScore.toFixed(3)}</div>
          <div style="font-size:9px;color:var(--subtle);margin-top:2px;">composite macro signal · positive = BTC-bullish</div>
        </div>
      </div>
    </div>

    <!-- AI Overview card -->
    <div class="card" style="position:relative;overflow:hidden;">
      <div style="position:absolute;top:-20px;right:-20px;width:80px;height:80px;border-radius:50%;background:radial-gradient(circle,rgba(0,201,122,0.1) 0%,transparent 70%);"></div>
      <div class="card-hdr">
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 6px rgba(0,201,122,0.8);"></div>
          <span class="card-title">CIO Intelligence</span>
        </div>
        <button onclick="switchBagTab('nav');setTimeout(()=>{navAgentProactive();},300);"
          style="font-size:9px;font-family:var(--mono);background:rgba(0,201,122,0.08);border:1px solid rgba(0,201,122,0.2);color:var(--green);padding:3px 8px;border-radius:var(--r-sm);cursor:pointer;">⚡ Auto</button>
      </div>
      <div class="card-body" id="bag-overview-ai">
        <div style="font-size:11px;color:var(--muted);line-height:1.7;">
          ${totalValue > 0
            ? `BAG Fund NAV is <strong style="color:var(--text);">${navFmt$(totalValue)}</strong> AUD.
               NAV per unit is <strong style="color:${navPerUnit>=1?'var(--green)':'var(--red)'};">${navPerUnit.toFixed(4)}</strong>
               (${navPct(navPerUnit-1,2)} since inception).<br><br>
               Model drift is <strong style="color:${drift>0.05?'var(--amber)':'var(--green)'};">${(drift*100).toFixed(1)}%</strong>
               ${drift>0.05?' — rebalance recommended.':' — within tolerance.'}
               Current signal targets <strong style="color:var(--amber);">${(signal.btcWeight*100).toFixed(1)}% BTC</strong>
               and <strong style="color:var(--green);">${(signal.goldWeight*100).toFixed(1)}% Gold</strong>.`
            : `No trades recorded yet. Add your first trade via the NAV &amp; Holdings page to start tracking the fund.`}
        </div>
        <div style="margin-top:12px;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);font-size:10px;color:var(--muted);line-height:1.65;" id="bag-pattern-box">
          Loading pattern analysis…
        </div>
        <div style="display:flex;gap:6px;margin-top:12px;">
          <input id="bag-overview-ask" placeholder="Ask about BAG Fund…"
            style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--text);font-family:var(--mono);font-size:10px;padding:7px 9px;outline:none;"
            onkeydown="if(event.key==='Enter'){switchBagTab('nav');setTimeout(()=>{navChatQuick(this.value);this.value='';},200);}"/>
          <button onclick="switchBagTab('nav');setTimeout(()=>{navChatQuick(document.getElementById('bag-overview-ask').value);document.getElementById('bag-overview-ask').value='';},200);"
            style="background:rgba(0,201,122,0.1);border:1px solid rgba(0,201,122,0.2);color:var(--green);border-radius:var(--r-sm);padding:7px 12px;font-family:var(--mono);font-size:11px;cursor:pointer;">↵</button>
        </div>
      </div>
    </div>
  `;

  // Render NAV per unit sparkline
  if (typeof Plotly !== 'undefined' && dateSeries.length > 1) {
    setTimeout(() => {
      const el = document.getElementById('bag-overview-nav-chart');
      if (!el) return;
      Plotly.react('bag-overview-nav-chart', [{
        x: dateSeries, y: navSeries, type: 'scatter', mode: 'lines',
        line: {color: '#00C97A', width: 2},
        fill: 'tozeroy', fillcolor: 'rgba(0,201,122,0.08)',
        hovertemplate: '%{x}: %{y:.4f}x<extra>NAV/unit</extra>'
      }], {
        paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
        margin: {l:0,r:0,t:0,b:0},
        xaxis: {visible:false}, yaxis: {visible:false, range:[minNPU, maxNPU]},
        showlegend: false, hovermode: 'x unified'
      }, {displayModeBar:false, responsive:true});
    }, 100);
  }

  // Load pattern analysis from AI (lightweight, no user interaction)
  _loadBagPatternAnalysis(signal, navPerUnit, drift);
}

async function _loadBagPatternAnalysis(signal, navPerUnit, drift) {
  const box = document.getElementById('bag-pattern-box');
  if (!box) return;
  // Use historical data to find closest analogues
  const hist = BAG_HISTORY.filter(r => r.btcWeight !== null);
  const closest = hist.filter(r => Math.abs(r.btcWeight - signal.btcWeight) < 0.05);
  if (closest.length >= 2) {
    const dates = closest.map(r => r.date).join(' and ');
    box.innerHTML = `Macro fingerprint closest to <strong style="color:var(--text);">${dates}</strong>. In the following months, Gold ${closest[0].goldRet > 0 ? 'outperformed' : 'underperformed'} BTC on average.`;
  } else {
    box.innerHTML = `BTC score of ${signal.btcScore.toFixed(3)} — ${signal.btcScore < 0 ? 'defensive positioning, Gold favoured by macro signal.' : 'growth-oriented macro signal, BTC allocation elevated.'}`;
  }
}

// ═══════════════════════════════════════
// SIGNAL PAGE
// ═══════════════════════════════════════
function renderBagSignalKPIs() {
  const signal = bagCurrentSignal();
  const data   = navLoad();
  const positions = computePositions(data.trades);
  const prices    = data.prices || {};
  let totalValue  = 0;
  Object.keys(positions).forEach(asset => {
    const p  = positions[asset];
    const cp = prices[asset] ? prices[asset].price : p.costBasis;
    totalValue += p.qty * cp;
  });

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('sig-kpi-btc',      (signal.btcWeight*100).toFixed(1)+'%');
  set('sig-kpi-gold',     (signal.goldWeight*100).toFixed(1)+'%');
  set('sig-kpi-btcscore', signal.btcScore.toFixed(3));
  const q = getNavRegimeCoords();
  if (q) {
    const el = document.getElementById('sig-kpi-regime');
    if (el) { el.textContent = q.quadrant; el.className = 'kpi-v'; el.style.color = {Expansion:'var(--green)',Deflation:'var(--blue)',Reflation:'var(--amber)',Stagflation:'var(--red)'}[q.quadrant]||'var(--text)'; }
  }

  // Drift
  const btcP    = positions['Bitcoin'];
  const goldP   = positions['PAX Gold'];
  const btcCp   = prices['Bitcoin']?.price  || (btcP  ? btcP.costBasis  : 0);
  const goldCp  = prices['PAX Gold']?.price || (goldP ? goldP.costBasis : 0);
  const btcVal  = btcP  ? btcP.qty  * btcCp  : 0;
  const goldVal = goldP ? goldP.qty * goldCp : 0;
  const tv      = btcVal + goldVal;
  const btcActual  = tv > 0 ? btcVal  / tv : 0;
  const goldActual = tv > 0 ? goldVal / tv : 0;
  const drift   = Math.abs(btcActual - signal.btcWeight) + Math.abs(goldActual - signal.goldWeight);
  set('sig-kpi-btc-drift', navPct(btcActual - signal.btcWeight, 1));
  const btcTrade  = (signal.btcWeight  - btcActual)  * tv;
  const goldTrade = (signal.goldWeight - goldActual) * tv;
  const tradeAmt  = Math.abs(btcTrade) > 1 ? navFmt$(Math.abs(btcTrade)) : '—';
  set('sig-kpi-trades', tradeAmt);
}

function renderBagSignal() {
  renderBagSignalKPIs();
  const grid = document.getElementById('bag-signal-grid');
  if (!grid) return;

  const signal    = bagCurrentSignal();
  const data      = navLoad();
  const positions = computePositions(data.trades);
  const prices    = data.prices || {};
  let totalValue  = 0;
  Object.keys(positions).forEach(asset => {
    const p  = positions[asset];
    const cp = prices[asset] ? prices[asset].price : p.costBasis;
    totalValue += p.qty * cp;
  });

  const btcActual  = positions['Bitcoin']  && totalValue > 0 ? positions['Bitcoin'].qty  * (prices['Bitcoin']?.price  || positions['Bitcoin'].costBasis)  / totalValue : 0;
  const goldActual = positions['PAX Gold'] && totalValue > 0 ? positions['PAX Gold'].qty * (prices['PAX Gold']?.price || positions['PAX Gold'].costBasis) / totalValue : 0;
  const btcTrade   = (signal.btcWeight  - btcActual)  * totalValue;
  const goldTrade  = (signal.goldWeight - goldActual) * totalValue;

  grid.innerHTML = `
    <!-- Weight comparison card -->
    <div class="card">
      <div class="card-hdr">
        <span class="card-title">Target vs Actual Weights</span>
        <span class="card-meta">model output</span>
      </div>
      <div class="card-body">
        ${[['Bitcoin','var(--amber)',signal.btcWeight,btcActual],['PAX Gold','var(--green)',signal.goldWeight,goldActual]].map(([name,color,target,actual]) => `
          <div style="margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
              <span style="font-size:12px;font-weight:600;color:var(--text);">${name}</span>
              <span style="font-family:var(--mono);font-size:14px;font-weight:500;color:${color};">${(target*100).toFixed(1)}%</span>
            </div>
            <div style="height:10px;background:var(--surface2);border-radius:5px;overflow:hidden;position:relative;margin-bottom:6px;">
              <div style="position:absolute;top:0;left:0;width:${(target*100).toFixed(1)}%;height:100%;background:${color};opacity:0.5;border-radius:5px;"></div>
              <div style="position:absolute;top:2px;left:0;width:${(actual*100).toFixed(1)}%;height:6px;background:${color};border-radius:5px;"></div>
            </div>
            <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:10px;">
              <span style="color:var(--subtle);">actual: ${(actual*100).toFixed(1)}%</span>
              <span style="color:${Math.abs(target-actual)>0.01?(target>actual?'var(--green)':'var(--red)'):'var(--subtle)'};">
                ${target > actual ? '▲' : target < actual ? '▼' : '='} ${(Math.abs(target-actual)*100).toFixed(1)}%
              </span>
            </div>
          </div>`).join('')}
      </div>
    </div>

    <!-- Required trades -->
    <div class="card">
      <div class="card-hdr">
        <span class="card-title">Required Trades</span>
        <span class="card-meta">to rebalance</span>
      </div>
      <div class="card-body">
        ${totalValue > 0 ? `
          ${[['Bitcoin', btcTrade, 'var(--amber)'], ['PAX Gold', goldTrade, 'var(--green)']].map(([name, tradeAmt, color]) => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);">
              <span style="font-size:12px;font-weight:600;color:var(--text);">${name}</span>
              <div style="text-align:right;">
                <div style="font-family:var(--mono);font-size:14px;font-weight:600;color:${tradeAmt>=0?'var(--green)':'var(--red)'};">
                  ${tradeAmt>=0?'+':''}${navFmt$(tradeAmt)}
                </div>
                <div style="font-family:var(--mono);font-size:9px;color:var(--subtle);">${tradeAmt >= 0 ? 'BUY' : 'SELL'}</div>
              </div>
            </div>`).join('')}
          <button onclick="navOpenTradeModal('Bitcoin','${btcTrade>=0?'buy':'sell'}');"
            style="width:100%;margin-top:12px;padding:8px;background:var(--green-dim);border:1px solid var(--green-mid);color:var(--green);border-radius:var(--r-sm);font-size:11px;font-weight:700;cursor:pointer;">
            + Add Rebalance Trade
          </button>
        ` : '<div style="font-size:11px;color:var(--subtle);text-align:center;padding:20px;">Add trades in NAV & Holdings to see required rebalancing.</div>'}
      </div>
    </div>

    <!-- Macro inputs -->
    <div class="card">
      <div class="card-hdr">
        <span class="card-title">Macro Inputs</span>
        <span class="card-meta" style="color:var(--amber);">⌖ regime calculator</span>
      </div>
      <div class="card-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
          ${[['ISM PMI','nav-rc-pmi','52.4'],['MVRV Z','','0.48'],['Fed Rate','nav-rc-gdp','3.75%'],['BTC Score','','signal']].map(([l,id,def]) => `
            <div style="padding:8px 10px;background:var(--surface2);border-radius:var(--r-sm);border:1px solid var(--border);">
              <div style="font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;margin-bottom:3px;">${l}</div>
              <div style="font-family:var(--mono);font-size:14px;color:var(--text);">${l==='BTC Score'?signal.btcScore.toFixed(3):def}</div>
            </div>`).join('')}
        </div>
        <div style="font-family:var(--mono);font-size:9px;color:var(--subtle);margin-bottom:8px;">Update inputs via NAV &amp; Holdings → Regime Calculator</div>
        <button onclick="switchBagTab('nav')"
          style="width:100%;padding:7px;background:var(--amber-dim);border:1px solid var(--amber);color:var(--amber);border-radius:var(--r-sm);font-size:10px;font-weight:700;cursor:pointer;">
          ↻ Update Regime Inputs
        </button>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════
// PERFORMANCE PAGE
// ═══════════════════════════════════════
function renderBagPerformance() {
  const histRows   = BAG_HISTORY.filter(r => r.date >= '2025-12' && r.navPerUnit !== null);
  const dates      = histRows.map(r => r.date);
  const navSeries  = histRows.map(r => r.navPerUnit);
  const rets       = histRows.filter(r => r.fundRet !== null).map(r => r.fundRet);
  const btcRets    = histRows.filter(r => r.btcRet  !== null).map(r => r.btcRet);
  const goldRets   = histRows.filter(r => r.goldRet !== null).map(r => r.goldRet);

  // Compute cumulative benchmark series
  let btcCum = 1, goldCum = 1;
  const btcCums  = [1];
  const goldCums = [1];
  for (let i = 0; i < btcRets.length - 1; i++) {
    btcCum  *= (1 + btcRets[i+1]);  btcCums.push(btcCum);
    goldCum *= (1 + goldRets[i+1]); goldCums.push(goldCum);
  }

  // Stats
  const totalRet   = navSeries[navSeries.length-1] - 1;
  const n          = rets.length;
  const mean       = rets.reduce((s,x) => s+x, 0) / Math.max(n,1);
  const std        = Math.sqrt(rets.reduce((s,x) => s+(x-mean)**2, 0) / Math.max(n-1,1));
  const sharpe     = std > 0 ? (mean/std)*Math.sqrt(12) : 0;
  const dn         = rets.filter(r => r < 0);
  const dd2        = dn.length ? Math.sqrt(dn.reduce((s,r) => s+r*r, 0)/dn.length) : 1e-9;
  const sortino    = mean / dd2 * Math.sqrt(12);
  let peak = 1, mdd = 0;
  for (const v of navSeries) { if (v > peak) peak = v; const d = (peak-v)/peak; if (d > mdd) mdd = d; }

  // Update KPI strip
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('perf-kpi-ret',     navPct(totalRet, 1));
  set('perf-kpi-sharpe',  sharpe.toFixed(2));
  set('perf-kpi-mdd',    '-' + (mdd*100).toFixed(1) + '%');
  set('perf-kpi-best',   '+' + (Math.max(...rets, 0)*100).toFixed(1) + '%');
  set('perf-kpi-worst',   (Math.min(...rets, 0)*100).toFixed(1) + '%');
  set('perf-kpi-sortino', sortino.toFixed(2));

  const grid = document.getElementById('bag-perf-grid');
  if (!grid) return;

  grid.innerHTML = `
    <div class="card card-span2">
      <div class="card-hdr"><span class="card-title">NAV per Unit — since inception</span><span class="card-meta">Dec 2025 → present · base = 1.000</span></div>
      <div class="card-body-flush"><div id="bag-perf-cumret" style="height:220px;"></div></div>
    </div>

    <div class="card">
      <div class="card-hdr"><span class="card-title">Monthly Returns</span><span class="card-meta">green = positive</span></div>
      <div class="card-body-flush"><div id="bag-perf-monthly" style="height:180px;"></div></div>
    </div>

    <div class="card">
      <div class="card-hdr"><span class="card-title">Drawdown</span><span class="card-meta">Max DD: -${(mdd*100).toFixed(1)}%</span></div>
      <div class="card-body-flush"><div id="bag-perf-dd" style="height:180px;"></div></div>
    </div>

    <div class="card">
      <div class="card-hdr"><span class="card-title">BTC Weight History</span><span class="card-meta">model allocation over time</span></div>
      <div class="card-body-flush"><div id="bag-perf-weights" style="height:180px;"></div></div>
    </div>

    <div class="card">
      <div class="card-hdr"><span class="card-title">Performance Summary</span><span class="card-meta">all-time</span></div>
      <div class="card-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          ${[
            ['Total Return',  navPct(totalRet,2), totalRet>=0?'g':'r'],
            ['Sharpe Ratio',  sharpe.toFixed(2), sharpe>=1.5?'g':sharpe>=0.8?'a':'r'],
            ['Sortino',       sortino.toFixed(2), 'b'],
            ['Max Drawdown', '-'+(mdd*100).toFixed(1)+'%', 'r'],
            ['Best Month',   '+'+(Math.max(...rets,0)*100).toFixed(1)+'%', 'g'],
            ['Worst Month',  (Math.min(...rets,0)*100).toFixed(1)+'%', 'r'],
            ['Months live',  n.toString(), 'w'],
            ['vs BTC',       navPct(totalRet-(btcCum-1),1), (totalRet-(btcCum-1))>=0?'g':'r'],
          ].map(([l,v,c]) => `
            <div class="kpi">
              <div class="kpi-l">${l}</div>
              <div class="kpi-v ${c}">${v}</div>
            </div>`).join('')}
        </div>
      </div>
    </div>
  `;

  // Render charts after DOM update
  setTimeout(() => {
    const CFG = {displayModeBar:false, responsive:true};
    const base = {
      paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
      font:{family:"'DM Mono',monospace",size:9,color:'#6B6F8E'},
      margin:{l:46,r:10,t:5,b:28},
      xaxis:{gridcolor:'#1C1F2E',linecolor:'#252840',tickfont:{size:8}},
      yaxis:{gridcolor:'#1C1F2E',linecolor:'#252840',tickfont:{size:8}},
      hovermode:'x unified', showlegend:true,
      legend:{bgcolor:'rgba(0,0,0,0)',font:{size:8},orientation:'h',y:-0.15}
    };

    // Cumulative return
    if (document.getElementById('bag-perf-cumret')) {
      Plotly.react('bag-perf-cumret', [
        {x:dates,y:navSeries,name:'BAG Fund',type:'scatter',mode:'lines',line:{color:'#E8E9F0',width:2.5},hovertemplate:'%{y:.4f}<extra>BAG</extra>'},
        {x:dates,y:btcCums,name:'Bitcoin',type:'scatter',mode:'lines',line:{color:'#FFB020',width:1.5,dash:'dot'},hovertemplate:'%{y:.4f}<extra>BTC</extra>'},
        {x:dates,y:goldCums,name:'Gold',type:'scatter',mode:'lines',line:{color:'#00C97A',width:1.5,dash:'dot'},hovertemplate:'%{y:.4f}<extra>Gold</extra>'},
      ], {...base, yaxis:{...base.yaxis,tickformat:'.3f'}}, CFG);
    }

    // Monthly bars
    const mDates = histRows.filter(r=>r.fundRet!==null).map(r=>r.date);
    const mRets  = histRows.filter(r=>r.fundRet!==null).map(r=>r.fundRet*100);
    if (document.getElementById('bag-perf-monthly')) {
      Plotly.react('bag-perf-monthly', [{
        x:mDates, y:mRets, type:'bar',
        marker:{color:mRets.map(v=>v>=0?'rgba(0,201,122,0.7)':'rgba(255,77,109,0.7)')},
        hovertemplate:'%{x}: %{y:.2f}%<extra></extra>'
      }], {...base,margin:{l:46,r:10,t:4,b:28},yaxis:{...base.yaxis,ticksuffix:'%'},showlegend:false}, CFG);
    }

    // Drawdown
    let peakNPU = 1;
    const ddSeries = navSeries.map(v => { if(v>peakNPU) peakNPU=v; return -((peakNPU-v)/peakNPU)*100; });
    if (document.getElementById('bag-perf-dd')) {
      Plotly.react('bag-perf-dd', [{
        x:dates, y:ddSeries, type:'scatter', mode:'lines', fill:'tozeroy',
        line:{color:'#FF4D6D',width:1}, fillcolor:'rgba(255,77,109,0.12)',
        hovertemplate:'%{y:.2f}%<extra>DD</extra>'
      }], {...base,margin:{l:46,r:10,t:4,b:28},yaxis:{...base.yaxis,ticksuffix:'%'},showlegend:false}, CFG);
    }

    // BTC weight history
    const wDates = BAG_HISTORY.filter(r=>r.btcWeight!==null).map(r=>r.date);
    const wBtc   = BAG_HISTORY.filter(r=>r.btcWeight!==null).map(r=>(r.btcWeight*100).toFixed(1));
    const wGold  = BAG_HISTORY.filter(r=>r.goldWeight!==null).map(r=>(r.goldWeight*100).toFixed(1));
    if (document.getElementById('bag-perf-weights')) {
      Plotly.react('bag-perf-weights', [
        {x:wDates, y:wBtc,  name:'BTC', type:'scatter', mode:'lines+markers', line:{color:'#FFB020',width:2}, marker:{size:5}, hovertemplate:'%{y}%<extra>BTC</extra>'},
        {x:wDates, y:wGold, name:'Gold',type:'scatter', mode:'lines+markers', line:{color:'#00C97A',width:2}, marker:{size:5}, hovertemplate:'%{y}%<extra>Gold</extra>'},
      ], {...base,margin:{l:46,r:10,t:4,b:28},yaxis:{...base.yaxis,ticksuffix:'%',range:[0,100]}}, CFG);
    }
  }, 100);
}

// ═══════════════════════════════════════
// NAV DASHBOARD (full holdings page)
// Ported and updated from marc_nav.js
// ═══════════════════════════════════════
function renderNavDashboard() {
  const data      = navLoad();
  const positions = computePositions(data.trades);
  const prices    = data.prices || {};
  const modelW    = getModelWeights();

  let totalValue=0, totalCost=0;
  Object.keys(positions).forEach(asset => {
    const p  = positions[asset];
    const cp = prices[asset] ? prices[asset].price : p.costBasis;
    totalValue += p.qty * cp;
    totalCost  += p.qty * p.costBasis;
  });
  const totalPnl = totalValue - totalCost;
  const totalRet = totalCost > 0 ? totalPnl / totalCost : 0;
  const n        = Object.keys(positions).length;

  // Drift
  let drift = 0;
  if (totalValue > 0) {
    Object.keys(modelW).forEach(a => {
      const p      = positions[a];
      const cp     = p ? (prices[a] ? prices[a].price : p.costBasis) : 0;
      const actual = p ? p.qty*cp/totalValue : 0;
      drift       += Math.abs(actual - modelW[a].weight);
    });
  }

  // MTD / YTD
  const metrics = computePerformanceMetrics(data.trades, prices);

  // Set KPIs
  const setKpi = (id, val, cls) => {
    const el = document.getElementById(id); if (!el) return;
    el.textContent = val;
    if (cls) el.className = 'ts-v ' + cls;
  };
  setKpi('nav-kpi-nav',     n ? navFmt$(totalValue) : '—', 'b');
  setKpi('nav-kpi-pnl',     totalCost>0 ? (totalPnl>=0?'+':'')+navFmt$(totalPnl) : '—', totalPnl>=0?'g':'r');
  setKpi('nav-kpi-ret',     totalCost>0 ? navPct(totalRet) : '—', totalRet>=0?'g':'r');
  setKpi('nav-kpi-drift',   n&&Object.keys(modelW).length ? (drift*100).toFixed(0)+'% drift' : '—', drift>0.15?'r':drift>0.08?'a':'g');
  setKpi('nav-kpi-pos',     n + ' position' + (n!==1?'s':''), 'b');
  setKpi('nav-kpi-updated', data.lastFetched ? new Date(data.lastFetched).toLocaleTimeString() : 'Manual');
  if (metrics.mtd) setKpi('nav-kpi-mtd', navPct(metrics.mtd.pct), metrics.mtd.pct>=0?'g':'r');
  if (metrics.ytd) setKpi('nav-kpi-ytd', navPct(metrics.ytd.pct), metrics.ytd.pct>=0?'g':'r');

  // Render regime panel + asset table + charts + ticker
  renderNavRegimePanel();
  renderAllAssetTable(positions, prices, modelW, totalValue);
  renderNavCharts(positions, prices, modelW, totalValue);
  renderPriceTicker();
  renderNavTradeLog(data.trades);
  const countEl = document.getElementById('nav-tradelog-count');
  if (countEl) countEl.textContent = data.trades.length + ' trade' + (data.trades.length!==1?'s':'');
}

function renderNavCharts(positions, prices, modelW, totalValue) {
  const CFG  = {displayModeBar:false, responsive:true};
  const base = {
    paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
    font:{family:"'DM Mono',monospace",size:9,color:'#6B6F8E'},
    margin:{l:4,r:4,t:4,b:4}, showlegend:false, height:160
  };
  const TC = {Equity:'#4D9FFF',ETF:'#A78BFA',Crypto:'#FFB020',Commodity:'#00C97A'};

  const held = Object.entries(positions)
    .map(([asset, p]) => {
      const cp    = prices[asset] ? prices[asset].price : p.costBasis;
      const value = p.qty * cp;
      const ao    = window.RAW.assets.find(a => a.asset === asset);
      return {asset, value, type: ao?.type || 'Equity'};
    })
    .filter(r => r.value > 0)
    .sort((a, b) => b.value - a.value);

  // Allocation donut
  if (held.length && document.getElementById('nav-chart-alloc')) {
    Plotly.react('nav-chart-alloc', [{
      labels:  held.map(r => r.asset),
      values:  held.map(r => +r.value.toFixed(2)),
      type:    'pie', hole: 0.52,
      marker:  {colors: held.map(r => TC[r.type]||'#888'), line:{color:'#0B0D14',width:1}},
      textfont:{size:9,color:'#E8E9F0'}, textinfo:'label+percent',
      hovertemplate:'%{label}: $%{value:,.0f}<extra></extra>'
    }], {...base, margin:{l:4,r:4,t:4,b:4}}, CFG);
  }

  // Actual vs model
  const cRows = Object.entries(modelW)
    .map(([asset, mh]) => {
      const p      = positions[asset];
      const cp     = p ? (prices[asset] ? prices[asset].price : p.costBasis) : 0;
      const actual = p && totalValue > 0 ? p.qty*cp/totalValue : 0;
      return {asset, actual, mw: mh.weight};
    })
    .sort((a, b) => b.mw - a.mw)
    .slice(0, 14);

  if (cRows.length && document.getElementById('nav-chart-compare')) {
    Plotly.react('nav-chart-compare', [
      {y:cRows.map(r=>r.asset), x:cRows.map(r=>+(r.actual*100).toFixed(1)), name:'Actual', type:'bar', orientation:'h', marker:{color:'#4D9FFF',opacity:0.85}, hovertemplate:'%{y}: %{x:.1f}%<extra>Actual</extra>'},
      {y:cRows.map(r=>r.asset), x:cRows.map(r=>+(r.mw*100).toFixed(1)),    name:'Model',  type:'bar', orientation:'h', marker:{color:'#00C97A',opacity:0.5},  hovertemplate:'%{y}: %{x:.1f}%<extra>Model</extra>'}
    ], {...base, barmode:'overlay', showlegend:true, margin:{l:72,r:8,t:4,b:20},
        xaxis:{gridcolor:'#1C1F2E',ticksuffix:'%',tickfont:{size:8}},
        yaxis:{tickfont:{size:8},automargin:true},
        legend:{x:0.6,y:1.05,bgcolor:'rgba(0,0,0,0)',font:{size:8}}}, CFG);
  }

  // P&L chart
  const pRows = held
    .map(r => {
      const p    = positions[r.asset];
      const cp   = prices[r.asset] ? prices[r.asset].price : p.costBasis;
      const cost = p.qty * p.costBasis;
      return {asset: r.asset, pnl: r.value - cost};
    })
    .sort((a, b) => b.pnl - a.pnl);

  if (pRows.length && document.getElementById('nav-chart-pnl')) {
    Plotly.react('nav-chart-pnl', [{
      y: pRows.map(r => r.asset),
      x: pRows.map(r => +r.pnl.toFixed(2)),
      type:'bar', orientation:'h',
      marker:{color: pRows.map(r => r.pnl>=0?'#00C97A':'#FF4D6D'), opacity:0.85},
      hovertemplate:'%{y}: $%{x:,.2f}<extra></extra>'
    }], {...base, margin:{l:72,r:8,t:4,b:20},
         xaxis:{gridcolor:'#1C1F2E',tickprefix:'$',tickfont:{size:8},zeroline:true,zerolinecolor:'#252840'},
         yaxis:{tickfont:{size:8},automargin:true}}, CFG);
  }
}

function renderAllAssetTable(positions, prices, modelWeights, totalValue) {
  const tbody = document.getElementById('nav-holdings-tbody');
  if (!tbody) return;

  // BAG Fund only trades Bitcoin and PAX Gold
  const BAG_ASSETS = ['Bitcoin', 'PAX Gold'];
  const TC = {Equity:'#4D9FFF',ETF:'#A78BFA',Crypto:'#FFB020',Commodity:'#00C97A'};

  const rows = BAG_ASSETS.map(assetName => {
    const ao = window.RAW.assets.find(a => a.asset === assetName);
    const p  = positions[assetName];
    const pd = prices[assetName];
    const mh = modelWeights[assetName];
    const cp = pd ? pd.price : (p ? p.costBasis : null);
    const c24 = pd ? pd.change24h : null;
    const value = p && cp ? p.qty * cp : 0;
    const cost  = p ? p.qty * p.costBasis : 0;
    const pnl   = value - cost;
    const pnlPct   = cost > 0 ? pnl/cost : 0;
    const actualPct = totalValue > 0 && p ? value/totalValue : 0;
    const mw        = mh ? mh.weight : 0;
    const delta     = actualPct - mw;
    const hasPos    = p && p.qty > 0.000001;
    const hasLive   = !!pd;
    const type      = ao ? ao.type : 'Crypto';
    const tc        = TC[type] || '#888';
    const dc        = Math.abs(delta)<0.02?'var(--green)':Math.abs(delta)<0.05?'var(--amber)':'var(--red)';
    const pc        = pnl>=0?'var(--green)':'var(--red)';
    const cc        = c24!=null?(c24>=0?'var(--green)':'var(--red)'):'var(--subtle)';

    return `<tr style="border-bottom:1px solid var(--border);"
      onmouseover="this.style.background='var(--surface2)'"
      onmouseout="this.style.background=''">
      <td style="padding:8px 10px;">
        <span style="font-weight:700;font-size:12px;">${assetName}</span>
        <span class="badge badge-${type}" style="margin-left:5px;font-size:8px;">${type.slice(0,3)}</span>
      </td>
      <td style="padding:8px 10px;text-align:right;font-family:var(--mono);font-size:11px;color:var(--muted);">${hasPos?navFmtQty(p.qty):'—'}</td>
      <td style="padding:8px 10px;text-align:right;font-family:var(--mono);font-size:11px;color:var(--muted);">${hasPos?'$'+p.costBasis.toLocaleString('en-AU',{maximumFractionDigits:2}):'—'}</td>
      <td style="padding:8px 10px;">
        <div class="live-price">
          <span class="live-dot ${hasLive?'live':'stale'}"></span>
          <span style="font-family:var(--mono);font-size:13px;font-weight:700;color:${hasLive?'var(--text)':'var(--muted)'};">${cp!=null?'$'+cp.toLocaleString('en-AU',{maximumFractionDigits:2}):'—'}</span>
        </div>
      </td>
      <td style="padding:8px 10px;text-align:right;font-family:var(--mono);font-size:11px;color:${cc};">${c24!=null?(c24>=0?'+':'')+c24.toFixed(2)+'%':'—'}</td>
      <td style="padding:8px 10px;text-align:right;font-family:var(--mono);font-size:13px;font-weight:600;">${hasPos?navFmt$(value):'—'}</td>
      <td class="pnl-cell" style="padding:8px 10px;text-align:right;font-family:var(--mono);font-size:11px;color:${pc};">
        ${hasPos?(pnl>=0?'+':'')+navFmt$(pnl)+'<br><span class="pnl-pct">'+(pnlPct>=0?'+':'')+(pnlPct*100).toFixed(1)+'%</span>':'—'}
      </td>
      <td style="padding:8px 10px;text-align:right;font-family:var(--mono);font-size:12px;">${hasPos?(actualPct*100).toFixed(1)+'%':'—'}</td>
      <td style="padding:8px 10px;text-align:right;font-family:var(--mono);font-size:12px;color:${tc};">${mw>0?(mw*100).toFixed(1)+'%':'—'}</td>
      <td style="padding:8px 10px;text-align:right;font-family:var(--mono);font-size:12px;font-weight:600;color:${dc};">
        ${(mw>0||hasPos)?(delta>=0?'+':'')+(delta*100).toFixed(1)+'%':'—'}
      </td>
      <td style="padding:8px 10px;text-align:center;white-space:nowrap;">
        <button onclick="navOpenTradeModal('${assetName}','buy')" style="font-size:9px;background:var(--green-dim);border:1px solid var(--green-mid);color:var(--green);padding:3px 8px;border-radius:2px;cursor:pointer;margin-right:4px;">Buy</button>
        ${hasPos?`<button onclick="navOpenTradeModal('${assetName}','sell')" style="font-size:9px;background:var(--red-dim);border:1px solid var(--red);color:var(--red);padding:3px 8px;border-radius:2px;cursor:pointer;">Sell</button>`:''}
      </td>
    </tr>`;
  });

  tbody.innerHTML = rows.join('');
}

function renderPriceTicker() {
  const ticker = document.getElementById('nav-price-ticker');
  if (!ticker) return;
  const prices = navLoad().prices || {};
  const TC = {Equity:'#4D9FFF',ETF:'#A78BFA',Crypto:'#FFB020',Commodity:'#00C97A'};
  // BAG Fund only shows BTC and PAXG
  const BAG_ASSETS = (window.RAW?.assets || []).filter(a => a.asset === 'Bitcoin' || a.asset === 'PAX Gold');
  ticker.innerHTML = BAG_ASSETS.map(a => {
    const pd  = prices[a.asset];
    const tc  = TC[a.type] || '#888';
    const price = pd ? pd.price : null;
    const chg   = pd ? pd.change24h : null;
    const chgColor = chg != null ? (chg >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--subtle)';
    return `<div class="price-pill">
      <span class="live-dot ${pd?'live':'stale'}"></span>
      <span class="pp-name" style="color:${tc};">${a.asset}</span>
      <span class="pp-price">${price?(price>=1000?'$'+(price/1000).toFixed(1)+'k':price<1?'$'+price.toFixed(4):'$'+price.toFixed(2)):'—'}</span>
      ${chg!=null?`<span class="pp-chg" style="color:${chgColor};">${chg>=0?'+':''}${chg.toFixed(1)}%</span>`:''}
    </div>`;
  }).join('');
}

function renderNavTradeLog(trades) {
  const el = document.getElementById('nav-trade-log');
  if (!el) return;
  const header = '<div style="padding:5px 12px;border-bottom:1px solid var(--border);background:var(--surface2);position:sticky;top:0;"><span style="font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;font-family:var(--mono);">Trade Log</span></div>';
  if (!trades.length) { el.innerHTML = header + '<div style="padding:20px;text-align:center;color:var(--subtle);font-size:10px;font-family:var(--mono);">No trades yet — click + Trade</div>'; return; }
  const sorted = [...trades].sort((a, b) => b.ts - a.ts);
  el.innerHTML = header + sorted.map(t => {
    const dc = t.direction==='buy'?'var(--green)':'var(--red)';
    const db = t.direction==='buy'?'var(--green-dim)':'var(--red-dim)';
    return `<div style="padding:7px 12px;border-bottom:1px solid var(--border);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">
        <span style="font-weight:600;font-size:11px;">${t.asset}</span>
        <span style="font-family:var(--mono);font-size:9px;padding:1px 6px;border-radius:2px;background:${db};color:${dc};font-weight:700;">${t.direction.toUpperCase()}</span>
      </div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--muted);">${navFmtQty(t.qty)} @ $${t.price.toFixed(2)}</div>
      <div style="display:flex;justify-content:space-between;margin-top:2px;">
        <span style="font-size:9px;color:var(--subtle);">${t.date}</span>
        <button onclick="navDeleteTrade('${t.id}')" style="background:none;border:none;color:var(--subtle);cursor:pointer;font-size:10px;padding:0;">✕</button>
      </div>
      ${t.notes?`<div style="font-size:9px;color:var(--subtle);margin-top:2px;font-style:italic;">${t.notes}</div>`:''}
    </div>`;
  }).join('');
}

function toggleTradeLog() {
  tradeLogOpen = !tradeLogOpen;
  const drawer = document.getElementById('nav-tradelog-drawer');
  const btn    = document.getElementById('nav-tradelog-btn');
  if (!drawer) return;
  drawer.style.transform = tradeLogOpen ? 'translateY(0)' : 'translateY(100%)';
  if (btn) { btn.style.borderColor = tradeLogOpen ? 'var(--green)' : ''; btn.style.color = tradeLogOpen ? 'var(--green)' : ''; }
  if (tradeLogOpen) renderNavTradeLogDrawer(navLoad().trades);
}

function renderNavTradeLogDrawer(trades) {
  const body = document.getElementById('nav-tradelog-body');
  if (!body) return;
  if (!trades.length) { body.innerHTML = '<tr><td colspan="8" style="padding:30px;text-align:center;color:var(--subtle);font-family:var(--mono);font-size:11px;">No trades recorded yet</td></tr>'; return; }
  const sorted = [...trades].sort((a, b) => b.ts - a.ts);
  body.innerHTML = sorted.map(t => {
    const dc = t.direction==='buy'?'var(--green)':'var(--red)';
    const db = t.direction==='buy'?'var(--green-dim)':'var(--red-dim)';
    const ao = window.RAW.assets.find(a => a.asset === t.asset);
    return `<tr style="border-bottom:1px solid var(--border);" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
      <td style="padding:6px 12px;font-size:11px;font-weight:600;">${t.asset}${ao?`<span class="badge badge-${ao.type}" style="margin-left:5px;">${ao.type.slice(0,3)}</span>`:''}</td>
      <td style="padding:6px 12px;"><span style="font-family:var(--mono);font-size:10px;padding:2px 8px;border-radius:2px;background:${db};color:${dc};font-weight:700;">${t.direction.toUpperCase()}</span></td>
      <td style="padding:6px 12px;font-family:var(--mono);font-size:11px;text-align:right;">${navFmtQty(t.qty)}</td>
      <td style="padding:6px 12px;font-family:var(--mono);font-size:11px;text-align:right;">$${t.price.toFixed(2)}</td>
      <td style="padding:6px 12px;font-family:var(--mono);font-size:11px;text-align:right;font-weight:600;">${navFmt$(t.qty*t.price)}</td>
      <td style="padding:6px 12px;font-size:10px;color:var(--muted);">${t.date}</td>
      <td style="padding:6px 12px;font-size:10px;color:var(--subtle);font-style:italic;">${t.notes||'—'}</td>
      <td style="padding:6px 12px;text-align:center;"><button onclick="navDeleteTrade('${t.id}')" style="background:none;border:none;color:var(--subtle);cursor:pointer;font-size:11px;">✕</button></td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════
// PERFORMANCE METRICS
// ═══════════════════════════════════════
function computePerformanceMetrics(trades, prices) {
  const now      = new Date();
  const mtdStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
  const ytdStart = new Date(now.getFullYear(), 0, 1).toISOString().slice(0,10);
  return {
    mtd: computePeriodReturn(trades, prices, mtdStart),
    ytd: computePeriodReturn(trades, prices, ytdStart)
  };
}

function computePeriodReturn(trades, prices, fromDate) {
  const periodTrades = trades.filter(t => t.date >= fromDate);
  if (!periodTrades.length) return null;
  let cost = 0, currentVal = 0;
  periodTrades.forEach(t => {
    const cp = prices[t.asset] ? prices[t.asset].price : t.price;
    if (t.direction === 'buy') { cost += t.qty*t.price; currentVal += t.qty*cp; }
    else { cost -= t.qty*t.price; currentVal -= t.qty*cp; }
  });
  if (cost <= 0) return null;
  return {pnl: currentVal-cost, pct: (currentVal-cost)/cost};
}

// ═══════════════════════════════════════
// TRADE MODAL
// ═══════════════════════════════════════
function navOpenTradeModal(asset, direction) {
  const modal = document.getElementById('nav-trade-modal');
  if (!modal) return;
  const sel = document.getElementById('nav-trade-asset');
  // BAG Fund only trades Bitcoin and PAX Gold
  const BAG_ASSETS = ['Bitcoin', 'PAX Gold'];
  sel.innerHTML = BAG_ASSETS.map(a =>
    `<option value="${a}"${a===asset?' selected':''}>${a}</option>`
  ).join('');
  if (direction) document.getElementById('nav-trade-dir').value = direction;
  document.getElementById('nav-trade-date').value  = new Date().toISOString().split('T')[0];
  document.getElementById('nav-trade-qty').value   = '';
  document.getElementById('nav-trade-price').value = '';
  document.getElementById('nav-trade-notes').value = '';
  document.getElementById('nav-trade-preview').textContent = 'Total: —';
  document.getElementById('nav-trade-title').textContent = (direction==='sell'?'Sell ':'Buy ') + (asset||'Asset');
  modal.style.display = 'flex';
  const update = () => {
    const qty   = parseFloat(document.getElementById('nav-trade-qty').value)   || 0;
    const price = parseFloat(document.getElementById('nav-trade-price').value) || 0;
    document.getElementById('nav-trade-preview').textContent = qty && price ? 'Total: ' + navFmt$(qty*price) : 'Total: —';
  };
  document.getElementById('nav-trade-qty').oninput   = update;
  document.getElementById('nav-trade-price').oninput = update;
}
function navCloseTradeModal() {
  const m = document.getElementById('nav-trade-modal');
  if (m) m.style.display = 'none';
}

async function navSaveTrade() {
  const asset = document.getElementById('nav-trade-asset').value;
  const dir   = document.getElementById('nav-trade-dir').value;
  const date  = document.getElementById('nav-trade-date').value;
  const qty   = parseFloat(document.getElementById('nav-trade-qty').value);
  const price = parseFloat(document.getElementById('nav-trade-price').value);
  const notes = document.getElementById('nav-trade-notes').value.trim();
  if (!asset || !date || !qty || qty<=0 || !price || price<=0) { alert('Fill in all fields.'); return; }
  const btn = document.querySelector('#nav-trade-modal button[onclick="navSaveTrade()"]');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
  try {
    const trade = {id: Date.now().toString(), asset, direction:dir, date, qty, price, notes, ts: Date.now()};
    await dbSaveTrade(trade);
    navCloseTradeModal();
    // Snapshot
    const data = navLoad(), positions = computePositions(data.trades), prices2 = data.prices || {};
    let totalValue=0, totalCost=0;
    Object.keys(positions).forEach(a => {
      const p=positions[a], cp=prices2[a]?prices2[a].price:p.costBasis;
      totalValue+=p.qty*cp; totalCost+=p.qty*p.costBasis;
    });
    const regime = document.getElementById('nav-regime-pill')?.textContent?.trim() || '';
    dbSaveSnapshot(totalValue, totalCost, totalValue-totalCost, regime);
    renderNavDashboard();
    renderBagOverview();
    checkDriftAlert();
  } catch(e) {
    alert('Failed to save trade: ' + e.message);
  }
  if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
}

async function navDeleteTrade(id) {
  if (!confirm('Delete this trade?')) return;
  await dbDeleteTrade(id);
  renderNavDashboard();
  renderBagOverview();
}

// ═══════════════════════════════════════
// CIO AGENT CHAT
// ═══════════════════════════════════════
function navChatAddMessage(role, content, isThinking) {
  const thread = document.getElementById('nav-chat-thread');
  const empty  = document.getElementById('nav-chat-empty');
  if (empty) empty.style.display = 'none';
  if (!thread) return null;
  const id     = 'msg-' + Date.now();
  const ts     = new Date().toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'});
  const div    = document.createElement('div');
  div.className = 'nav-chat-msg ' + role + (isThinking ? ' nav-chat-thinking' : '');
  div.id = id;
  const bubble = document.createElement('div');
  bubble.className = 'nav-chat-bubble';
  if (isThinking)     bubble.textContent = '⬡ Analysing…';
  else if (role==='user') bubble.textContent = content;
  else bubble.innerHTML = renderMarkdown(content);
  const tsEl = document.createElement('div');
  tsEl.className = 'nav-chat-ts'; tsEl.textContent = ts;
  div.appendChild(bubble); div.appendChild(tsEl);
  thread.appendChild(div); thread.scrollTop = thread.scrollHeight;
  return id;
}

function navChatUpdateMessage(id, content) {
  const msg = document.getElementById(id);
  if (!msg) return;
  msg.classList.remove('nav-chat-thinking');
  const bubble = msg.querySelector('.nav-chat-bubble');
  if (bubble) bubble.innerHTML = renderMarkdown(content);
  const thread = document.getElementById('nav-chat-thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
}

async function navChatSend() {
  const input   = document.getElementById('nav-chat-input');
  const sendBtn = document.getElementById('nav-chat-send-btn');
  if (!input) return;
  const msg = input.value.trim(); if (!msg) return;
  input.value = '';
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '…'; }
  await navChatDispatch(msg);
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '▶'; }
}

function navChatQuick(msg) {
  const input = document.getElementById('nav-chat-input');
  if (input) { input.value = msg; } navChatSend();
}

async function navAgentProactive() {
  const btn = document.getElementById('nav-agent-proactive-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⚡ …'; }
  await navChatDispatch('Give me a proactive portfolio analysis. Focus on: (1) biggest misalignments vs the model, (2) top 3 action items right now, (3) any risks given the current regime. Be concise with specific dollar amounts.', true);
  if (btn) { btn.disabled = false; btn.textContent = '⚡ Auto'; }
}

async function navChatDispatch(userMsg, silent) {
  if (!silent) navChatAddMessage('user', userMsg);
  dbSaveMessage('user', userMsg);
  navChatHistory.push({role:'user', content: buildAgentPrompt(userMsg)});
  const thinkingId = navChatAddMessage('agent', '', true);
  try {
    const r = await fetch(_api() + '/ai', {
      method: 'POST',
      headers: {'Content-Type':'application/json','Origin':'https://mtc-ash.github.io'},
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `You are the CIO agent for MTC Strategy Suite — a professional macro regime-based portfolio management tool.
You manage the BAG Fund (Bitcoin And Gold), a systematic fund that allocates between BTC and PAXG using a macro factor model.
You have access to the user's live portfolio, model weights, current regime, and market prices.
Be a sharp, direct financial advisor. Use specific numbers. Format responses with ## headers and bullet points for actions.
Keep responses focused and under 400 words unless asked for detail.`,
        messages: navChatHistory
      })
    });
    const d     = await r.json();
    const reply = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : 'No response.';
    navChatUpdateMessage(thinkingId, reply);
    dbSaveMessage('assistant', reply);
    navChatHistory.push({role:'assistant', content: reply});
    if (navChatHistory.length > 20) navChatHistory = navChatHistory.slice(-20);
  } catch(e) {
    navChatUpdateMessage(thinkingId, `**Error:** ${e.message}\n\nCheck Worker deployment.`);
  }
}

function buildAgentPrompt(userMsg) {
  let snapshot = '';
  try {
    const data = navLoad(), positions = computePositions(data.trades), prices = data.prices || {};
    const mw = getModelWeights();
    let totalValue = 0;
    Object.entries(positions).forEach(([asset, p]) => {
      const cp = prices[asset] ? prices[asset].price : p.costBasis;
      totalValue += p.qty * cp;
    });
    const regimeName = document.getElementById('nav-regime-pill')?.textContent?.trim() || '—';
    const signal = bagCurrentSignal();
    snapshot = `[BAG FUND CONTEXT — ${new Date().toLocaleString()}]\n`
      + `Regime: ${regimeName}\n`
      + `NAV: ${navFmt$(totalValue)} | NAV/unit: ${bagLatestHistory().navPerUnit?.toFixed(4)||'—'}\n`
      + `BAG Signal: BTC ${(signal.btcWeight*100).toFixed(1)}% | Gold ${(signal.goldWeight*100).toFixed(1)}% | Score: ${signal.btcScore.toFixed(3)}\n`
      + `Positions: ${Object.entries(positions).filter(([,p])=>p.qty>0).map(([a,p])=>{
          const cp=prices[a]?prices[a].price:p.costBasis;
          const pct=totalValue>0?(p.qty*cp/totalValue*100).toFixed(1):'0';
          const model=mw[a]?(mw[a].weight*100).toFixed(1):'0';
          return `${a}: ${pct}% actual / ${model}% model`;
        }).join(', ')}\n\n`;
  } catch(e) {}
  return snapshot + userMsg;
}

async function navAgentClearChat() {
  navChatHistory = [];
  await dbClearMessages();
  const thread = document.getElementById('nav-chat-thread');
  if (thread) thread.innerHTML = `<div id="nav-chat-empty" style="text-align:center;padding:30px 10px;color:var(--subtle);font-size:11px;font-family:var(--mono);">Ask anything about your portfolio<br><span style="font-size:9px;opacity:.6;">or click ⚡ Auto for a proactive analysis</span></div>`;
}
function navRunAgent() { navAgentProactive(); }

// ═══════════════════════════════════════
// EXPORT / CLEAR
// ═══════════════════════════════════════
function navExport() {
  const data = navLoad();
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([JSON.stringify({exported:new Date().toISOString(),...data},null,2)],{type:'application/json'}));
  a.download = 'mtc-bag-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
}
function navClear() {
  if (!confirm('Clear ALL trade history? Cannot be undone.')) return;
  _marcDB.cache.trades = [];
  navSave({trades:[]});
  renderNavDashboard();
  renderBagOverview();
}

// ═══════════════════════════════════════
// ALERT ENGINE
// ═══════════════════════════════════════
function checkDriftAlert() {
  const data      = navLoad();
  const positions = computePositions(data.trades);
  const prices    = data.prices || {};
  const signal    = bagCurrentSignal();
  let totalValue = 0;
  Object.keys(positions).forEach(asset => {
    const p  = positions[asset];
    const cp = prices[asset] ? prices[asset].price : p.costBasis;
    totalValue += p.qty * cp;
  });
  if (totalValue <= 0) return;
  const btcActual  = positions['Bitcoin']  ? positions['Bitcoin'].qty  * (prices['Bitcoin']?.price  || positions['Bitcoin'].costBasis)  / totalValue : 0;
  const goldActual = positions['PAX Gold'] ? positions['PAX Gold'].qty * (prices['PAX Gold']?.price || positions['PAX Gold'].costBasis) / totalValue : 0;
  const drift = Math.abs(btcActual - signal.btcWeight) + Math.abs(goldActual - signal.goldWeight);
  if (drift > 0.05 && typeof addAlert === 'function') {
    addAlert('warn', 'Rebalance recommended', `BAG Fund drift is ${(drift*100).toFixed(1)}% — above 5% threshold. Model targets BTC ${(signal.btcWeight*100).toFixed(1)}% / Gold ${(signal.goldWeight*100).toFixed(1)}%.`);
  }
}

// ═══════════════════════════════════════
// MARKDOWN RENDERER (ported from marc_nav.js)
// ═══════════════════════════════════════
function renderMarkdown(text) {
  let h = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  h = h.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  h = h.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  h = h.replace(/^# (.+)$/gm,'<h2>$1</h2>');
  h = h.replace(/^---+$/gm,'<hr>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
  h = h.replace(/\*([^*\n]+)\*/g,'<em>$1</em>');
  h = h.replace(/`([^`\n]+)`/g,'<code>$1</code>');
  h = h.replace(/((?:^[ \t]*[-*] [^\n]+\n?)+)/gm, m =>
    '<ul>'+m.trim().split('\n').map(l=>'<li>'+l.replace(/^[ \t]*[-*] /,'')+'</li>').join('')+'</ul>');
  h = h.replace(/((?:^[ \t]*\d+\. [^\n]+\n?)+)/gm, m =>
    '<ol>'+m.trim().split('\n').map(l=>'<li>'+l.replace(/^[ \t]*\d+\. /,'')+'</li>').join('')+'</ol>');
  const lines = h.split('\n'); let out = [], i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.match(/^\|/) && i+1 < lines.length && lines[i+1].match(/^\|[-| :]+\|/)) {
      const hdrCells = line.split('|').slice(1,-1).map(s=>'<th>'+s.trim()+'</th>').join('');
      i += 2;
      let rows = '';
      while (i < lines.length && lines[i].match(/^\|/)) {
        rows += '<tr>'+lines[i].split('|').slice(1,-1).map(s=>'<td>'+s.trim()+'</td>').join('')+'</tr>';
        i++;
      }
      out.push('<table><thead><tr>'+hdrCells+'</tr></thead><tbody>'+rows+'</tbody></table>');
    } else { out.push(line); i++; }
  }
  h = out.join('\n');
  h = h.replace(/^(?!<[htuo\d\/]|$)(.+)$/gm,'<p>$1</p>');
  return h;
}

// ═══════════════════════════════════════
// BAG TAB SWITCHING — wire up sub-page renders
// Called from index.html switchBagTab()
// ═══════════════════════════════════════
// Override the shell's switchBagTab to also trigger renders
const _origSwitchBagTab = typeof switchBagTab !== 'undefined' ? switchBagTab : null;
function switchBagTab(tab) {
  // Update tab buttons
  document.querySelectorAll('#mode-bag .stab').forEach((t, i) => {
    const tabs = ['overview','nav','signal','performance','funddata','models'];
    t.classList.toggle('active', tabs[i] === tab);
  });
  document.querySelectorAll('#mode-bag .subpage').forEach(p => p.classList.remove('active'));
  const page = document.getElementById('bag-' + tab);
  if (page) page.classList.add('active');

  // Trigger render for each page
  if (tab === 'overview')    renderBagOverview();
  if (tab === 'nav')         { renderNavRegimePanel(); renderNavDashboard(); }
  if (tab === 'signal')      renderBagSignal();
  if (tab === 'performance') renderBagPerformance();
  if (tab === 'funddata')    renderBagFundData();
  if (tab === 'models')      renderModelLibrary();

  setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
}

// ═══════════════════════════════════════
// FUND DATA PAGE
// Monthly inputs: units, applications, redemptions, NAV
// ═══════════════════════════════════════
function renderBagFundData() {
  const grid = document.getElementById('bag-funddata-grid');
  if (!grid) return;

  // Load saved fund data from localStorage
  let fundData = {};
  try { fundData = JSON.parse(localStorage.getItem('mtc_bag_funddata') || '{}'); } catch(e) {}

  // Current month
  const now = new Date();
  const currentMonth = now.toISOString().slice(0,7);

  // Build month list from inception
  const months = [];
  let d = new Date('2025-12-01');
  while (d <= now) {
    months.push(d.toISOString().slice(0,7));
    d.setMonth(d.getMonth() + 1);
  }

  grid.innerHTML = `
    <!-- Monthly Entry Form -->
    <div class="card">
      <div class="card-hdr">
        <span class="card-title">Monthly Update</span>
        <span class="card-meta">applications · redemptions · NAV</span>
      </div>
      <div class="card-body">

        <div style="margin-bottom:14px;">
          <div style="font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Period</div>
          <select id="fd-month" class="ctrl-sel" style="width:100%;padding:6px 8px;font-size:12px;" onchange="loadFundDataMonth()">
            ${months.reverse().map(m => `<option value="${m}" ${m===currentMonth?'selected':''}>${m}</option>`).join('')}
          </select>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
          <div>
            <div style="font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Units on Issue</div>
            <input type="number" id="fd-units" placeholder="e.g. 1259886.75" step="any"
              style="width:100%;font-family:var(--mono);font-size:12px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:var(--r-sm);box-sizing:border-box;outline:none;"/>
          </div>
          <div>
            <div style="font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">NAV per Unit</div>
            <input type="number" id="fd-navpu" placeholder="e.g. 1.0294" step="any"
              style="width:100%;font-family:var(--mono);font-size:12px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:var(--r-sm);box-sizing:border-box;outline:none;"/>
          </div>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:12px;margin-bottom:14px;">
          <div style="font-family:var(--mono);font-size:9px;color:var(--green);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Applications (Capital In)</div>
          <div id="fd-apps-list"></div>
          <button onclick="addFundDataEntry('app')"
            style="width:100%;padding:6px;background:var(--green-dim);border:1px solid var(--green-mid);color:var(--green);border-radius:var(--r-sm);font-size:10px;font-weight:700;cursor:pointer;margin-top:6px;">
            + Add Application
          </button>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:12px;margin-bottom:14px;">
          <div style="font-family:var(--mono);font-size:9px;color:var(--red);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Redemptions (Capital Out)</div>
          <div id="fd-reds-list"></div>
          <button onclick="addFundDataEntry('red')"
            style="width:100%;padding:6px;background:var(--red-dim);border:1px solid var(--red);color:var(--red);border-radius:var(--r-sm);font-size:10px;font-weight:700;cursor:pointer;margin-top:6px;">
            + Add Redemption
          </button>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:12px;margin-bottom:14px;">
          <div style="font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Fees This Month (AUD)</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <div>
              <div style="font-size:9px;color:var(--subtle);margin-bottom:3px;">Management Fee</div>
              <input type="number" id="fd-mgmtfee" placeholder="auto-calculated" step="any"
                style="width:100%;font-family:var(--mono);font-size:11px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:5px 7px;border-radius:var(--r-sm);box-sizing:border-box;outline:none;"/>
            </div>
            <div>
              <div style="font-size:9px;color:var(--subtle);margin-bottom:3px;">BC Admin Fee</div>
              <input type="number" id="fd-bcfee" placeholder="3850" step="any"
                style="width:100%;font-family:var(--mono);font-size:11px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:5px 7px;border-radius:var(--r-sm);box-sizing:border-box;outline:none;"/>
            </div>
          </div>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:12px;margin-bottom:8px;">
          <div style="font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Notes</div>
          <textarea id="fd-notes" placeholder="e.g. Monthly rebalance completed. New investor onboarded."
            style="width:100%;font-family:var(--mono);font-size:11px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:var(--r-sm);resize:none;height:60px;box-sizing:border-box;outline:none;line-height:1.5;"></textarea>
        </div>

        <button onclick="saveFundDataMonth()"
          style="width:100%;padding:9px;background:var(--green);color:#000;border:none;border-radius:var(--r-sm);font-size:12px;font-weight:700;cursor:pointer;letter-spacing:.3px;">
          ✓ Save Month
        </button>
        <div id="fd-save-status" style="font-family:var(--mono);font-size:9px;color:var(--muted);margin-top:6px;text-align:center;min-height:14px;"></div>
      </div>
    </div>

    <!-- Fund History Table -->
    <div class="card">
      <div class="card-hdr">
        <span class="card-title">Fund History</span>
        <span class="card-meta">all months</span>
      </div>
      <div class="card-body-flush" id="fd-history-table">
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead>
            <tr style="background:var(--surface2);">
              <th style="padding:8px 12px;text-align:left;font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border);">Month</th>
              <th style="padding:8px 12px;text-align:right;font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border);">Units</th>
              <th style="padding:8px 12px;text-align:right;font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border);">NAV/Unit</th>
              <th style="padding:8px 12px;text-align:right;font-family:var(--mono);font-size:9px;color:var(--green);letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border);">Apps</th>
              <th style="padding:8px 12px;text-align:right;font-family:var(--mono);font-size:9px;color:var(--red);letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border);">Reds</th>
              <th style="padding:8px 12px;text-align:right;font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border);">Net Flow</th>
            </tr>
          </thead>
          <tbody>
            ${months.map(m => {
              const row = fundData[m];
              if (!row) return `<tr style="border-bottom:1px solid var(--border);opacity:.4;">
                <td style="padding:7px 12px;font-family:var(--mono);font-size:10px;color:var(--muted);">${m}</td>
                <td colspan="5" style="padding:7px 12px;font-size:10px;color:var(--subtle);font-style:italic;">No data entered</td>
              </tr>`;
              const apps = (row.applications||[]).reduce((s,a) => s + (parseFloat(a.amount)||0), 0);
              const reds = (row.redemptions||[]).reduce((s,a)  => s + (parseFloat(a.amount)||0), 0);
              const net  = apps - reds;
              return `<tr style="border-bottom:1px solid var(--border);" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
                <td style="padding:7px 12px;font-family:var(--mono);font-size:11px;font-weight:600;">${m}</td>
                <td style="padding:7px 12px;text-align:right;font-family:var(--mono);font-size:10px;color:var(--muted);">${row.units ? parseFloat(row.units).toLocaleString('en-AU',{maximumFractionDigits:2}) : '—'}</td>
                <td style="padding:7px 12px;text-align:right;font-family:var(--mono);font-size:11px;color:${row.navpu>=1?'var(--green)':'var(--red)'};">${row.navpu ? parseFloat(row.navpu).toFixed(4) : '—'}</td>
                <td style="padding:7px 12px;text-align:right;font-family:var(--mono);font-size:11px;color:var(--green);">${apps > 0 ? '$'+apps.toLocaleString('en-AU',{maximumFractionDigits:0}) : '—'}</td>
                <td style="padding:7px 12px;text-align:right;font-family:var(--mono);font-size:11px;color:var(--red);">${reds > 0 ? '-$'+reds.toLocaleString('en-AU',{maximumFractionDigits:0}) : '—'}</td>
                <td style="padding:7px 12px;text-align:right;font-family:var(--mono);font-size:11px;color:${net>=0?'var(--green)':'var(--red)'};">${net !== 0 ? (net>=0?'+':'')+navFmt$(net) : '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Load current month data into form
  loadFundDataMonth();
}

function loadFundDataMonth() {
  let fundData = {};
  try { fundData = JSON.parse(localStorage.getItem('mtc_bag_funddata') || '{}'); } catch(e) {}
  const month = document.getElementById('fd-month')?.value;
  if (!month) return;
  const row = fundData[month] || {};
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  set('fd-units',   row.units   || '');
  set('fd-navpu',   row.navpu   || '');
  set('fd-mgmtfee', row.mgmtfee || '');
  set('fd-bcfee',   row.bcfee   || '3850');
  set('fd-notes',   row.notes   || '');
  renderFundDataEntries('app', row.applications || []);
  renderFundDataEntries('red', row.redemptions  || []);
}

function renderFundDataEntries(type, entries) {
  const container = document.getElementById(`fd-${type}s-list`);
  if (!container) return;
  if (!entries.length) {
    container.innerHTML = `<div style="font-size:10px;color:var(--subtle);font-family:var(--mono);padding:4px 0;">None this month</div>`;
    return;
  }
  container.innerHTML = entries.map((e, i) => `
    <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:6px;align-items:center;margin-bottom:6px;">
      <input type="text" placeholder="Investor name" value="${e.name||''}"
        onchange="updateFundDataEntry('${type}',${i},'name',this.value)"
        style="font-family:var(--mono);font-size:11px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:5px 7px;border-radius:var(--r-sm);outline:none;"/>
      <input type="number" placeholder="AUD amount" value="${e.amount||''}"
        onchange="updateFundDataEntry('${type}',${i},'amount',this.value)"
        style="font-family:var(--mono);font-size:11px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:5px 7px;border-radius:var(--r-sm);outline:none;"/>
      <button onclick="removeFundDataEntry('${type}',${i})"
        style="background:none;border:1px solid var(--border);color:var(--subtle);cursor:pointer;padding:4px 8px;border-radius:var(--r-sm);font-size:11px;">✕</button>
    </div>`).join('');
}

// In-memory staging for current form entries
let _fdApps = [], _fdReds = [];

function addFundDataEntry(type) {
  if (type === 'app') { _fdApps.push({name:'',amount:''}); renderFundDataEntries('app', _fdApps); }
  else                { _fdReds.push({name:'',amount:''}); renderFundDataEntries('red', _fdReds); }
}
function updateFundDataEntry(type, idx, field, val) {
  if (type === 'app') _fdApps[idx][field] = val;
  else                _fdReds[idx][field] = val;
}
function removeFundDataEntry(type, idx) {
  if (type === 'app') { _fdApps.splice(idx,1); renderFundDataEntries('app', _fdApps); }
  else                { _fdReds.splice(idx,1); renderFundDataEntries('red', _fdReds); }
}

function saveFundDataMonth() {
  const month = document.getElementById('fd-month')?.value;
  if (!month) return;
  let fundData = {};
  try { fundData = JSON.parse(localStorage.getItem('mtc_bag_funddata') || '{}'); } catch(e) {}
  fundData[month] = {
    units:        document.getElementById('fd-units')?.value   || '',
    navpu:        document.getElementById('fd-navpu')?.value   || '',
    mgmtfee:      document.getElementById('fd-mgmtfee')?.value || '',
    bcfee:        document.getElementById('fd-bcfee')?.value   || '',
    notes:        document.getElementById('fd-notes')?.value   || '',
    applications: _fdApps.filter(e => e.name || e.amount),
    redemptions:  _fdReds.filter(e => e.name || e.amount),
    savedAt:      new Date().toISOString()
  };
  try {
    localStorage.setItem('mtc_bag_funddata', JSON.stringify(fundData));
    const st = document.getElementById('fd-save-status');
    if (st) { st.textContent = '✓ Saved'; st.style.color = 'var(--green)'; setTimeout(() => { if(st) st.textContent=''; }, 3000); }
    // Refresh the history table
    renderBagFundData();
  } catch(e) {
    const st = document.getElementById('fd-save-status');
    if (st) { st.textContent = '✗ Save failed: ' + e.message; st.style.color = 'var(--red)'; }
  }
  if (typeof addAlert === 'function') {
    const apps = _fdApps.reduce((s,a) => s + (parseFloat(a.amount)||0), 0);
    const reds = _fdReds.reduce((s,a)  => s + (parseFloat(a.amount)||0), 0);
    if (apps > 0) addAlert('info', 'Application recorded', `${month}: $${apps.toLocaleString('en-AU')} AUD`);
    if (reds > 0) addAlert('warn', 'Redemption recorded',  `${month}: $${reds.toLocaleString('en-AU')} AUD`);
  }
}

// ═══════════════════════════════════════
// INIT — runs after DOMContentLoaded
// Auth handled by mtc_lab.js DOMContentLoaded
// This just wires up BAG-specific things
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', function() {
  // Render overview immediately using cached data (even before auth)
  setTimeout(() => {
    renderBagOverview();
    checkDriftAlert();
  }, 500);
});
