// ═══════════════════════════════════════════════════════════════
// MARC NAV — Forward-looking portfolio layer
// Requires marc_data.js (window.RAW) and marc_app.js (computeWeights)
// Manages: Regime Calc · Model Portfolio · Holdings · Live Prices · CIO Agent
// ═══════════════════════════════════════════════════════════════

// ── NAV State ──────────────────────────────────────────────────────────────
var navState = {
  regimeCoords: null,   // {rx, ry, quadrant} — from calc or last backtest quarter
  liveCoords:   null,   // override from Regime Calc
};

// ── Storage ────────────────────────────────────────────────────────────────
function navLoad() {
  try { return JSON.parse(localStorage.getItem('marc_nav') || '{"trades":[],"prices":{}}'); }
  catch(e) { return {trades:[], prices:{}}; }
}
function navSave(data) { localStorage.setItem('marc_nav', JSON.stringify(data)); }

// ── Position engine ────────────────────────────────────────────────────────
function computePositions(trades) {
  var pos = {};
  trades.forEach(function(t) {
    if (!pos[t.asset]) pos[t.asset] = {qty:0, costBasis:0};
    var p = pos[t.asset];
    if (t.direction === 'buy') {
      var newQty = p.qty + t.qty;
      p.costBasis = newQty > 0 ? (p.costBasis * p.qty + t.price * t.qty) / newQty : 0;
      p.qty = newQty;
    } else {
      p.qty = Math.max(0, p.qty - t.qty);
    }
  });
  Object.keys(pos).forEach(function(k){ if(pos[k].qty <= 0.000001) delete pos[k]; });
  return pos;
}

// ── Formatters ─────────────────────────────────────────────────────────────
function navFmt$(v) {
  if (isNaN(v)||v==null) return '—';
  var abs = Math.abs(v);
  if (abs >= 1e6) return (v<0?'-':'') + '$' + (abs/1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (v<0?'-':'') + '$' + (abs/1e3).toFixed(1) + 'k';
  return (v<0?'-':'') + '$' + abs.toFixed(2);
}
function navFmtQty(v) {
  if (v >= 1e6)   return (v/1e6).toFixed(2) + 'M';
  if (v >= 1e3)   return (v/1e3).toFixed(2) + 'k';
  if (v < 0.001)  return v.toFixed(6);
  if (v < 1)      return v.toFixed(4);
  return v.toFixed(2);
}
function navPct(v, dec) { return (v>=0?'+':'') + (v*100).toFixed(dec||1) + '%'; }

// ── Get active regime coords ────────────────────────────────────────────────
// Priority: 1) live calc override, 2) last backtest quarter
function getNavRegimeCoords() {
  if (navState.liveCoords) return navState.liveCoords;
  // Fall back to last quarter from backtest
  if (typeof quarterly !== 'undefined' && typeof endDate !== 'undefined') {
    var qKeys = Object.keys(quarterly).filter(function(qk){return qk<=endDate;}).sort();
    if (qKeys.length) return quarterly[qKeys[qKeys.length-1]];
  }
  return null;
}

// ── Get model weights for current coords ───────────────────────────────────
function getModelWeights() {
  var q = getNavRegimeCoords();
  if (!q) return {};
  var lastQk = Object.keys(window.RAW.quarterly).sort().pop();
  var avail = window.RAW.assets.filter(function(a){return a.first_data && a.first_data<=lastQk;}).map(function(a){return a.asset;});
  var holdings = computeWeights(q.rx, q.ry, avail, params.alpha, params.mcbeta, params.n);
  var weights = {};
  holdings.forEach(function(h){ weights[h.asset] = h; });
  return weights;
}


// ══════════════════════════════════════════════════════════════════════════
// TRADE LOG DRAWER
// ══════════════════════════════════════════════════════════════════════════
var tradeLogOpen = false;
function toggleTradeLog() {
  tradeLogOpen = !tradeLogOpen;
  var drawer = document.getElementById('nav-tradelog-drawer');
  var btn    = document.getElementById('nav-tradelog-btn');
  if (!drawer) return;
  drawer.style.transform = tradeLogOpen ? 'translateY(0)' : 'translateY(100%)';
  if (btn) btn.style.background = tradeLogOpen ? 'var(--surface3)' : '';
  if (tradeLogOpen) {
    var data = navLoad();
    renderNavTradeLogDrawer(data.trades);
  }
}

function renderNavTradeLogDrawer(trades) {
  var body = document.getElementById('nav-tradelog-body');
  if (!body) return;
  if (!trades.length) {
    body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--subtle);font-size:11px;font-family:var(--mono);">No trades recorded yet</div>';
    return;
  }
  var sorted = trades.slice().sort(function(a,b){return b.ts-a.ts;});

  // Group by month
  var grouped = {};
  sorted.forEach(function(t) {
    var month = t.date.slice(0,7);
    if (!grouped[month]) grouped[month] = [];
    grouped[month].push(t);
  });

  body.innerHTML = Object.keys(grouped).sort().reverse().map(function(month) {
    var monthTrades = grouped[month];
    var rows = monthTrades.map(function(t) {
      var dc = t.direction==='buy'?'var(--green)':'var(--red)';
      var db = t.direction==='buy'?'var(--green-dim)':'var(--red-dim)';
      return '<tr class="nav-tlog-row">'
        +'<td style="padding:6px 12px;font-size:11px;font-weight:600;">'+t.asset+'</td>'
        +'<td style="padding:6px 12px;"><span style="font-family:var(--mono);font-size:10px;padding:2px 8px;border-radius:2px;background:'+db+';color:'+dc+';font-weight:700;">'+t.direction.toUpperCase()+'</span></td>'
        +'<td style="padding:6px 12px;font-family:var(--mono);font-size:11px;text-align:right;">'+navFmtQty(t.qty)+'</td>'
        +'<td style="padding:6px 12px;font-family:var(--mono);font-size:11px;text-align:right;">$'+t.price.toFixed(2)+'</td>'
        +'<td style="padding:6px 12px;font-family:var(--mono);font-size:11px;text-align:right;font-weight:600;">'+navFmt$(t.qty*t.price)+'</td>'
        +'<td style="padding:6px 12px;font-size:10px;color:var(--muted);">'+t.date+'</td>'
        +'<td style="padding:6px 12px;font-size:10px;color:var(--subtle);font-style:italic;">'+(t.notes||'—')+'</td>'
        +'<td style="padding:6px 12px;text-align:center;"><button onclick="navDeleteTrade(\''+t.id+'\')" style="background:none;border:none;color:var(--subtle);cursor:pointer;font-size:11px;padding:0;">✕</button></td>'
        +'</tr>';
    }).join('');
    return '<tr style="background:var(--surface2);"><td colspan="8" style="padding:5px 12px;font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;font-family:var(--mono);">'+month+'</td></tr>'
      + rows;
  }).join('');
}

// ══════════════════════════════════════════════════════════════════════════
// NAV SECTION — show/hide the whole NAV layer
// ══════════════════════════════════════════════════════════════════════════
function showNavSection() {
  var navSection = document.getElementById('nav-section');
  if (!navSection) return;
  var isVisible = navSection.style.display === 'flex';
  navSection.style.display = isVisible ? 'none' : 'flex';
  var btn = document.querySelector('[onclick="showNavSection()"]');
  if (btn) btn.style.background = isVisible ? '' : 'var(--green-dim)';
  if (!isVisible) {
    renderNavRegimePanel();
    renderNavDashboard();
    renderNavAgentContext();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// REGIME PANEL (left column)
// ══════════════════════════════════════════════════════════════════════════
function renderNavRegimePanel() {
  var q = getNavRegimeCoords();
  if (!q) return;
  var RC = {Expansion:'#00D68F',Deflation:'#4D9FFF',Reflation:'#FFB020',Stagflation:'#FF4D6D'};
  var qc = RC[q.quadrant] || '#888';

  var pill = document.getElementById('nav-regime-pill');
  var coord = document.getElementById('nav-regime-coord');
  var src = document.getElementById('nav-regime-source');
  if (pill) { pill.textContent = q.quadrant; pill.style.background=''; pill.className='rpill rpill-'+q.quadrant.charAt(0); }
  if (coord) coord.textContent = '(' + q.rx.toFixed(4) + ', ' + q.ry.toFixed(4) + ')';
  if (src) src.textContent = navState.liveCoords ? 'Live calc' : 'Last backtest quarter';

  // Model portfolio in left panel
  var modelWeights = getModelWeights();
  var mList = document.getElementById('nav-model-list');
  if (!mList) return;
  var sorted = Object.values(modelWeights).sort(function(a,b){return b.weight-a.weight;});
  if (!sorted.length) {
    mList.innerHTML = '<div style="color:var(--subtle);font-size:10px;padding:8px;">Run backtest first</div>';
    return;
  }
  var TC = {Equity:'#4D9FFF',ETF:'#A78BFA',Crypto:'#FFB020',Commodity:'#00D68F'};
  mList.innerHTML = sorted.map(function(h,i) {
    var barW = Math.min(100, Math.round(h.weight * 100 * 3));
    var tc = TC[h.type]||'#888';
    return '<div class="nav-model-row">'
      +'<span class="nav-model-rank">'+(i+1)+'</span>'
      +'<span class="nav-model-name">'+h.asset+'</span>'
      +'<span style="font-size:9px;color:'+tc+';font-family:var(--mono);margin-right:4px;">'+h.type.slice(0,3)+'</span>'
      +'<div class="nav-model-bar-wrap"><div class="nav-model-bar" style="width:'+barW+'%;background:'+tc+';"></div></div>'
      +'<span class="nav-model-pct" style="color:'+tc+';">'+(h.weight*100).toFixed(1)+'%</span>'
      +'</div>';
  }).join('');
}


// ══════════════════════════════════════════════════════════════════════════
// FRED AUTO-FILL — fetch latest macro data and pre-fill regime calc
// ══════════════════════════════════════════════════════════════════════════
async function navFetchMacro() {
  var btn = document.getElementById('nav-macro-btn');
  if (btn) { btn.textContent='↻ Fetching…'; btn.disabled=true; }

  try {
    var r = await fetch(PROXY_URL + 'macro');
    var d = await r.json();

    if (d.error) throw new Error(d.error);

    // Pre-fill regime calculator inputs
    if (d.gdp  != null) { var el=document.getElementById('nav-rc-gdp');   if(el) el.value=d.gdp.toFixed(4); }
    if (d.unemp!= null) { var el=document.getElementById('nav-rc-unemp'); if(el) el.value=d.unemp.toFixed(1); }
    if (d.cpi  != null) { var el=document.getElementById('nav-rc-cpi');   if(el) el.value=d.cpi.toFixed(2); }
    if (d.pce  != null) { var el=document.getElementById('nav-rc-pce');   if(el) el.value=d.pce.toFixed(2); }
    if (d.retail!=null) { var el=document.getElementById('nav-rc-retail');if(el) el.value=d.retail.toFixed(2); }
    // PMI not available on FRED — leave for manual entry

    // Show data dates
    var srcEl = document.getElementById('nav-macro-source');
    if (srcEl && d.dates) {
      var dateStr = Object.entries(d.dates)
        .filter(function(kv){return kv[1];})
        .map(function(kv){return kv[0].toUpperCase()+':'+kv[1].slice(0,7);})
        .join('  ');
      srcEl.textContent = 'FRED data as of: ' + dateStr + ' · PMI: enter manually';
    }

    // Auto-compute regime after filling
    navComputeRegime();

  } catch(e) {
    console.error('Macro fetch error:', e);
    var srcEl = document.getElementById('nav-macro-source');
    if (srcEl) srcEl.textContent = 'FRED fetch failed: ' + e.message;
  }
  if (btn) { btn.textContent='↻ Auto-fill from FRED'; btn.disabled=false; }
}

// ══════════════════════════════════════════════════════════════════════════
// REGIME CALCULATOR (inside NAV left panel)
// ══════════════════════════════════════════════════════════════════════════
function navComputeRegime() {
  var get = function(id) { return parseFloat(document.getElementById(id)?.value); };
  var gdp=get('nav-rc-gdp'), pmi=get('nav-rc-pmi'), unemp=get('nav-rc-unemp'),
      retail=get('nav-rc-retail'), cpi=get('nav-rc-cpi'), pce=get('nav-rc-pce');
  if ([gdp,pmi,unemp,retail,cpi,pce].some(isNaN)) { alert('Fill in all 6 indicators.'); return; }
  var h=Math.max(-7,Math.min(7,(gdp*100-1)*3));
  var i=Math.max(-7,Math.min(7,(pmi-50)*0.65));
  var j=Math.max(-7,Math.min(7,(unemp-4.5)*2.8*-1));
  var k=Math.max(-7,Math.min(7,(retail-0.3)*2));
  var l=Math.max(-7,Math.min(7,(cpi-2.5)*2));
  var m=Math.max(-7,Math.min(7,(pce-2)*2));
  var x = (h*2+i*3+j*2+k*1)/8;
  var y = (l*3+m*2)/5;
  var quad = x>=0&&y<0?'Expansion':x<0&&y<0?'Deflation':x>=0&&y>=0?'Reflation':'Stagflation';
  navState.liveCoords = {rx:parseFloat(x.toFixed(4)), ry:parseFloat(y.toFixed(4)), quadrant:quad};
  // Show result
  var res = document.getElementById('nav-rc-result');
  if (res) {
    var RC = {Expansion:'#00D68F',Deflation:'#4D9FFF',Reflation:'#FFB020',Stagflation:'#FF4D6D'};
    res.innerHTML = '<div style="margin-top:8px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;">'
      +'<div style="font-family:var(--mono);font-size:9px;color:var(--subtle);margin-bottom:4px;">RESULT</div>'
      +'<div style="font-size:14px;font-weight:700;color:'+(RC[quad]||'#888')+';margin-bottom:2px;">'+quad+'</div>'
      +'<div style="font-family:var(--mono);font-size:10px;color:var(--muted);">X='+x.toFixed(4)+' | Y='+y.toFixed(4)+'</div>'
      +'</div>';
  }
  renderNavRegimePanel();
  renderNavDashboard();
  renderNavAgentContext();
}

// ══════════════════════════════════════════════════════════════════════════
// DASHBOARD (center column)
// ══════════════════════════════════════════════════════════════════════════
function renderNavDashboard() {
  var data = navLoad();
  var positions = computePositions(data.trades);
  var prices = data.prices || {};
  var modelWeights = getModelWeights();

  // Totals
  var totalValue=0, totalCost=0;
  Object.keys(positions).forEach(function(asset) {
    var p = positions[asset];
    var cp = prices[asset] ? prices[asset].price : p.costBasis;
    totalValue += p.qty * cp;
    totalCost  += p.qty * p.costBasis;
  });
  var totalPnl = totalValue - totalCost;
  var totalRet = totalCost > 0 ? totalPnl/totalCost : 0;
  var n = Object.keys(positions).length;

  // Drift
  var drift = 0;
  if (totalValue > 0) {
    Object.keys(modelWeights).forEach(function(a) {
      var p = positions[a];
      var cp = p ? (prices[a] ? prices[a].price : p.costBasis) : 0;
      var actual = p ? (p.qty*cp/totalValue) : 0;
      drift += Math.abs(actual - modelWeights[a].weight);
    });
  }

  // MTD / YTD performance
  var now = new Date();
  var mtdStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
  var ytdStart = new Date(now.getFullYear(), 0, 1).toISOString().slice(0,10);

  function calcPeriodReturn(trades, prices, sinceDate) {
    // Build positions as of sinceDate (cost only for pre-period trades)
    var snapPos = {}, snapVal = 0, currentVal = 0;
    trades.filter(function(t){return t.date < sinceDate;}).forEach(function(t) {
      if (!snapPos[t.asset]) snapPos[t.asset] = {qty:0, cost:0};
      var sp = snapPos[t.asset];
      if (t.direction==='buy') { sp.cost += t.qty*t.price; sp.qty += t.qty; }
      else { sp.cost *= Math.max(0,sp.qty-t.qty)/Math.max(sp.qty,0.000001); sp.qty = Math.max(0,sp.qty-t.qty); }
    });
    Object.keys(snapPos).forEach(function(asset) {
      var sp = snapPos[asset];
      if (sp.qty <= 0) return;
      var cp = prices[asset] ? prices[asset].price : (sp.cost/sp.qty);
      var startPrice = sp.cost/sp.qty; // avg cost as proxy for start-of-period price
      snapVal += sp.qty * startPrice;
      currentVal += sp.qty * cp;
    });
    // Include period buys at cost
    trades.filter(function(t){return t.date >= sinceDate && t.direction==='buy';}).forEach(function(t){
      snapVal += t.qty * t.price;
      var cp = prices[t.asset] ? prices[t.asset].price : t.price;
      currentVal += t.qty * cp;
    });
    return snapVal > 0 ? (currentVal - snapVal) / snapVal : null;
  }

  var mtdRet = data.trades.length ? calcPeriodReturn(data.trades, prices, mtdStart) : null;
  var ytdRet = data.trades.length ? calcPeriodReturn(data.trades, prices, ytdStart) : null;

  // KPIs
  var setKpi = function(id, val, cls) {
    var el = document.getElementById(id); if(!el) return;
    el.textContent = val;
    if (cls) el.className = 'ts-v '+cls;
  };
  setKpi('nav-kpi-nav',    n ? navFmt$(totalValue) : '—', 'b');
  setKpi('nav-kpi-pnl',    totalCost>0 ? (totalPnl>=0?'+':'')+navFmt$(totalPnl) : '—', totalPnl>=0?'g':'r');
  setKpi('nav-kpi-ret',    totalCost>0 ? navPct(totalRet) : '—', totalRet>=0?'g':'r');
  setKpi('nav-kpi-drift',  n&&Object.keys(modelWeights).length ? (drift*100).toFixed(0)+'% drift' : '—', drift>0.15?'r':drift>0.08?'a':'g');
  setKpi('nav-kpi-pos',    n+' position'+(n!==1?'s':''), 'b');
  var lf = data.lastFetched ? new Date(data.lastFetched).toLocaleTimeString() : 'Manual';
  setKpi('nav-kpi-updated', lf);
  setKpi('nav-kpi-mtd', mtdRet!=null ? navPct(mtdRet) : '—', mtdRet!=null?(mtdRet>=0?'g':'r'):'');
  setKpi('nav-kpi-ytd', ytdRet!=null ? navPct(ytdRet) : '—', ytdRet!=null?(ytdRet>=0?'g':'r'):'');

  // Build rows
  var allAssets = new Set(Object.keys(positions));
  Object.keys(modelWeights).forEach(function(a){allAssets.add(a);});
  var rows = [];
  allAssets.forEach(function(asset) {
    var p = positions[asset];
    var mh = modelWeights[asset];
    var pd = prices[asset];
    var cp = pd ? pd.price : (p ? p.costBasis : 0);
    var c24 = pd ? pd.change24h : null;
    var value = p ? p.qty*cp : 0;
    var cost  = p ? p.qty*p.costBasis : 0;
    var pnl   = value-cost;
    var pnlPct = cost>0 ? pnl/cost : 0;
    var actualPct = totalValue>0&&p ? value/totalValue : 0;
    var mw = mh ? mh.weight : 0;
    var delta = actualPct - mw;
    var ao = window.RAW.assets.find(function(a){return a.asset===asset;});
    rows.push({asset,p,cp,c24,value,cost,pnl,pnlPct,actualPct,mw,delta,ao,hasLive:!!pd,hasPos:p&&p.qty>0});
  });
  rows.sort(function(a,b){return b.value-a.value;});

  // MTD / YTD metrics
  var metrics = computePerformanceMetrics(data.trades, prices);
  var setPerf = function(id, m) {
    var el = document.getElementById(id); if (!el) return;
    if (!m) { el.textContent='—'; el.className='ts-v'; return; }
    el.textContent = (m.pct>=0?'+':'')+(m.pct*100).toFixed(1)+'%';
    el.className = 'ts-v '+(m.pct>=0?'g':'r');
  };
  setPerf('nav-kpi-mtd', metrics.mtd);
  setPerf('nav-kpi-ytd', metrics.ytd);

  // ALL-ASSET table (replaces sparse holdings table)
  var TC = {Equity:'#4D9FFF',ETF:'#A78BFA',Crypto:'#FFB020',Commodity:'#00D68F'};
  renderAllAssetTable(positions, prices, modelWeights, totalValue);
  if (false) { var tbody = document.getElementById('nav-holdings-tbody');
  if (tbody) {
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="11" style="padding:40px;text-align:center;color:var(--subtle);font-size:11px;font-family:var(--mono);">No trades yet — click + Trade to get started</td></tr>';
    } else {
      tbody.innerHTML = rows.map(function(r) {
        var dc = Math.abs(r.delta)<0.02?'var(--green)':Math.abs(r.delta)<0.05?'var(--amber)':'var(--red)';
        var pc = r.pnl>=0?'var(--green)':'var(--red)';
        var cc = r.c24!=null?(r.c24>=0?'var(--green)':'var(--red)'):'var(--subtle)';
        var type = r.ao ? r.ao.type : '';
        var typeColor = TC[type]||'#888';
        return '<tr style="border-bottom:1px solid var(--border);'+(r.hasPos?'':'opacity:0.4;')+'" '
          +'onmouseover="this.style.background=\'var(--surface2)\'" onmouseout="this.style.background=\'\'">'
          +'<td style="padding:5px 10px;"><span style="font-weight:600;font-size:11px;">'+r.asset+'</span>'
          +(type?'<span class="badge badge-'+type+'" style="margin-left:4px;">'+type.slice(0,3)+'</span>':'')+'</td>'
          +'<td style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:10px;color:var(--muted);">'+(r.hasPos?navFmtQty(r.p.qty):'—')+'</td>'
          +'<td style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:10px;color:var(--muted);">'+(r.hasPos?'$'+r.p.costBasis.toFixed(2):'—')+'</td>'
          +'<td style="padding:5px 10px;"><div class="live-price">'
          +'<span class="live-dot '+(r.hasLive?'live':'stale')+'"></span>'
          +'<span style="font-family:var(--mono);font-size:12px;font-weight:600;color:'+(r.hasLive?'var(--text)':'var(--muted)')+';">'+(r.hasPos||r.hasLive?navFmt$(r.cp):'—')+'</span>'
          +'</div></td>'
          +'<td style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:10px;color:'+cc+';">'
          +(r.c24!=null?(r.c24>=0?'+':'')+r.c24.toFixed(2)+'%':'—')+'</td>'
          +'<td style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:11px;font-weight:600;">'+(r.hasPos?navFmt$(r.value):'—')+'</td>'
          +'<td style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:10px;color:'+pc+';">'
          +(r.hasPos?(r.pnl>=0?'+':'')+navFmt$(r.pnl)+'<br><span style="font-size:9px;">'+(r.pnlPct>=0?'+':'')+(r.pnlPct*100).toFixed(1)+'%</span>':'—')+'</td>'
          +'<td style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:11px;">'+(r.hasPos?(r.actualPct*100).toFixed(1)+'%':'—')+'</td>'
          +'<td style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:11px;color:'+typeColor+';">'+(r.mw>0?(r.mw*100).toFixed(1)+'%':'—')+'</td>'
          +'<td style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:11px;font-weight:600;color:'+dc+';">'
          +((r.mw>0||r.hasPos)?(r.delta>=0?'+':'')+(r.delta*100).toFixed(1)+'%':'—')+'</td>'
          +'<td style="padding:5px 10px;text-align:center;">'
          +'<button onclick="navOpenTradeModal(\''+r.asset+'\',\'buy\')" style="font-size:9px;background:var(--green-dim);border:1px solid var(--green-mid);color:var(--green);padding:2px 5px;border-radius:2px;cursor:pointer;margin-right:2px;">B</button>'
          +(r.hasPos?'<button onclick="navOpenTradeModal(\''+r.asset+'\',\'sell\')" style="font-size:9px;background:var(--red-dim);border:1px solid var(--red);color:var(--red);padding:2px 5px;border-radius:2px;cursor:pointer;">S</button>':'')
          +'</td></tr>';
      }).join('');
    }
  } } // end if(false)

  // Charts
  renderNavCharts(rows, totalValue);

  // Trade log
  renderNavTradeLog(data.trades);

  // Price ticker
  renderPriceTicker();

  // Trade log drawer count
  var countEl = document.getElementById('nav-tradelog-count');
  if (countEl) countEl.textContent = data.trades.length + ' trade' + (data.trades.length!==1?'s':'');
}

function renderNavCharts(rows, totalValue) {
  var CFG = {displayModeBar:false, responsive:true};
  var base = {
    paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
    font:{family:"'DM Mono',monospace", size:9, color:'#8888AA'},
    margin:{l:4,r:4,t:4,b:4}, showlegend:false
  };
  var TC = {Equity:'#4D9FFF',ETF:'#A78BFA',Crypto:'#FFB020',Commodity:'#00D68F'};
  var held = rows.filter(function(r){return r.hasPos&&r.value>0;});

  // Allocation donut
  if (held.length && document.getElementById('nav-chart-alloc')) {
    Plotly.react('nav-chart-alloc', [{
      labels:held.map(function(r){return r.asset;}),
      values:held.map(function(r){return +(r.value.toFixed(2));}),
      type:'pie', hole:0.52,
      marker:{colors:held.map(function(r){return TC[r.ao?r.ao.type:'ETF']||'#888';}),line:{color:'#0C0C0F',width:1}},
      textfont:{size:9,color:'#F0EFF8'}, textinfo:'label+percent',
      hovertemplate:'%{label}: $%{value:,.0f}<extra></extra>'
    }], Object.assign({},base,{margin:{l:4,r:4,t:4,b:4}}), CFG);
  }

  // Actual vs model
  var cRows = rows.filter(function(r){return r.mw>0||r.hasPos;}).slice(0,14);
  if (cRows.length && document.getElementById('nav-chart-compare')) {
    Plotly.react('nav-chart-compare', [
      {y:cRows.map(function(r){return r.asset;}),
       x:cRows.map(function(r){return +(r.actualPct*100).toFixed(1);}),
       name:'Actual', type:'bar', orientation:'h',
       marker:{color:'#4D9FFF',opacity:0.85},
       hovertemplate:'%{y}: %{x:.1f}%<extra>Actual</extra>'},
      {y:cRows.map(function(r){return r.asset;}),
       x:cRows.map(function(r){return +(r.mw*100).toFixed(1);}),
       name:'Model', type:'bar', orientation:'h',
       marker:{color:'#00D68F',opacity:0.5},
       hovertemplate:'%{y}: %{x:.1f}%<extra>Model</extra>'}
    ], Object.assign({},base,{
      barmode:'overlay', showlegend:true,
      margin:{l:72,r:8,t:4,b:20},
      xaxis:{gridcolor:'#1A1A2A',ticksuffix:'%',tickfont:{size:8}},
      yaxis:{tickfont:{size:8},automargin:true},
      legend:{x:0.6,y:1.05,bgcolor:'rgba(0,0,0,0)',font:{size:8}}
    }), CFG);
  }

  // P&L
  var pRows = rows.filter(function(r){return r.hasPos;}).sort(function(a,b){return b.pnl-a.pnl;}).slice(0,12);
  if (pRows.length && document.getElementById('nav-chart-pnl')) {
    Plotly.react('nav-chart-pnl', [{
      y:pRows.map(function(r){return r.asset;}),
      x:pRows.map(function(r){return +r.pnl.toFixed(2);}),
      type:'bar', orientation:'h',
      marker:{color:pRows.map(function(r){return r.pnl>=0?'#00D68F':'#FF4D6D';}),opacity:0.85},
      hovertemplate:'%{y}: $%{x:,.2f}<extra></extra>'
    }], Object.assign({},base,{
      margin:{l:72,r:8,t:4,b:20},
      xaxis:{gridcolor:'#1A1A2A',tickprefix:'$',tickfont:{size:8},zeroline:true,zerolinecolor:'#2A2A3A'},
      yaxis:{tickfont:{size:8},automargin:true}
    }), CFG);
  }
}

function renderNavTradeLog(trades) {
  var el = document.getElementById('nav-trade-log');
  if (!el) return;
  var header = '<div style="padding:5px 12px;border-bottom:1px solid var(--border);background:var(--surface2);position:sticky;top:0;"><span style="font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;font-family:var(--mono);">Trade Log</span></div>';
  if (!trades.length) {
    el.innerHTML = header + '<div style="padding:20px;text-align:center;color:var(--subtle);font-size:10px;font-family:var(--mono);">No trades yet — click + Trade</div>';
    return;
  }
  var sorted = trades.slice().sort(function(a,b){return b.ts-a.ts;});
  el.innerHTML = header + sorted.map(function(t) {
    var dc = t.direction==='buy'?'var(--green)':'var(--red)';
    var db = t.direction==='buy'?'var(--green-dim)':'var(--red-dim)';
    return '<div style="padding:7px 12px;border-bottom:1px solid var(--border);">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">'
      +'<span style="font-weight:600;font-size:11px;">'+t.asset+'</span>'
      +'<span style="font-family:var(--mono);font-size:9px;padding:1px 6px;border-radius:2px;background:'+db+';color:'+dc+';font-weight:700;">'+t.direction.toUpperCase()+'</span>'
      +'</div>'
      +'<div style="font-family:var(--mono);font-size:10px;color:var(--muted);">'+navFmtQty(t.qty)+' @ $'+t.price.toFixed(2)+'</div>'
      +'<div style="display:flex;justify-content:space-between;margin-top:2px;">'
      +'<span style="font-size:9px;color:var(--subtle);">'+t.date+'</span>'
      +'<button onclick="navDeleteTrade(\''+t.id+'\')" style="background:none;border:none;color:var(--subtle);cursor:pointer;font-size:10px;padding:0;">✕</button>'
      +'</div>'
      +(t.notes?'<div style="font-size:9px;color:var(--subtle);margin-top:2px;font-style:italic;">'+t.notes+'</div>':'')
      +'</div>';
  }).join('');
}


// ── All-assets price ticker ────────────────────────────────────────────
function renderPriceTicker() {
  var ticker = document.getElementById('nav-price-ticker');
  if (!ticker) return;
  var data = navLoad();
  var prices = data.prices || {};
  var assets = window.RAW ? window.RAW.assets : [];
  if (!assets.length) return;

  var TC = {Equity:'#4D9FFF',ETF:'#A78BFA',Crypto:'#FFB020',Commodity:'#00D68F'};

  ticker.innerHTML = assets.map(function(a) {
    var pd = prices[a.asset];
    var tc = TC[a.type]||'#888';
    var price = pd ? pd.price : null;
    var chg = pd ? pd.change24h : null;
    var chgColor = chg!=null ? (chg>=0?'var(--green)':'var(--red)') : 'var(--subtle)';
    var dot = pd ? '<span class="live-dot live"></span>' : '<span class="live-dot stale"></span>';
    return '<div class="price-pill">'
      +dot
      +'<span class="pp-name" style="color:'+tc+';">'+a.asset+'</span>'
      +'<span class="pp-price">'+(price ? (price>=1000?'$'+(price/1000).toFixed(1)+'k':price<1?'$'+price.toFixed(4):'$'+price.toFixed(2)) : '—')+'</span>'
      +(chg!=null?'<span class="pp-chg" style="color:'+chgColor+';">'+(chg>=0?'+':'')+chg.toFixed(1)+'%</span>':'')
      +'</div>';
  }).join('');
}

// ══════════════════════════════════════════════════════════════════════════
// LIVE PRICE FETCH
// ══════════════════════════════════════════════════════════════════════════
async function navFetchPrices() {
  var btn = document.getElementById('nav-price-btn');
  var updatedEl = document.getElementById('nav-kpi-updated');
  if (btn) { btn.textContent='↻ Fetching\u2026'; btn.disabled=true; }

  var allAssets = window.RAW ? window.RAW.assets.map(function(a){return a.asset;}) : [];
  var base = (PROXY_URL||'').replace(/\/+$/, '');

  var CRYPTO = ['Bitcoin','Ethereum','XRP','BNB','Solana','Tron','Hyperliquid',
    'Chainlink','Sui','Avalanche','Uniswap','Jupiter','Hedera','Monero','Zcash',
    'Gold','Silver'];

  var cryptoAssets = allAssets.filter(function(a){ return CRYPTO.indexOf(a)>=0; });
  var equityAssets = allAssets.filter(function(a){ return CRYPTO.indexOf(a)<0; });

  async function fetchGroup(assets, label) {
    if (!assets.length) return;
    try {
      var r = await fetch(base + '/prices?assets=' + assets.join(','));
      var result = await r.json();
      if (result.prices && Object.keys(result.prices).length) {
        var d = navLoad();
        if (!d.prices) d.prices = {};
        Object.assign(d.prices, result.prices);
        d.lastFetched = new Date().toISOString();
        navSave(d);
        renderNavDashboard();
      }
    } catch(e) { console.error('Price fetch ('+label+'):', e.message); }
  }

  // Phase 1: crypto + Gold + Silver via CMC (instant)
  await fetchGroup(cryptoAssets, 'crypto');

  // Phase 2: equities/ETFs via Twelve Data — max 7 per call (free tier: 8/min)
  var batch1 = equityAssets.slice(0, 7);
  var batch2 = equityAssets.slice(7);

  if (batch1.length) {
    if (btn) btn.textContent = '\u21bb Equities 1/2\u2026';
    await fetchGroup(batch1, 'equity-1');
  }

  if (batch2.length) {
    if (btn) btn.textContent = '\u21bb Waiting 62s\u2026';
    if (updatedEl) updatedEl.textContent = 'Equity batch 2 in 62s\u2026';
    await new Promise(function(r){ setTimeout(r, 62000); });
    if (btn) btn.textContent = '\u21bb Equities 2/2\u2026';
    await fetchGroup(batch2, 'equity-2');
  }

  if (btn) { btn.textContent='\u21bb Refresh Prices'; btn.disabled=false; }
  renderNavDashboard();
}

// ══════════════════════════════════════════════════════════════════════════
// TRADE MODAL
// ══════════════════════════════════════════════════════════════════════════
function navOpenTradeModal(asset, direction) {
  var modal = document.getElementById('nav-trade-modal');
  if (!modal) return;
  var sel = document.getElementById('nav-trade-asset');
  sel.innerHTML = window.RAW.assets.map(function(a) {
    return '<option value="'+a.asset+'"'+(a.asset===asset?' selected':'')+'>'+a.asset+' ('+a.type+')</option>';
  }).join('');
  if (direction) document.getElementById('nav-trade-dir').value = direction;
  document.getElementById('nav-trade-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('nav-trade-qty').value = '';
  document.getElementById('nav-trade-price').value = '';
  document.getElementById('nav-trade-notes').value = '';
  document.getElementById('nav-trade-preview').textContent = 'Total: —';
  document.getElementById('nav-trade-title').textContent = (direction==='sell'?'Sell ':'Buy ')+(asset||'Asset');
  modal.style.display = 'flex';
  var update = function() {
    var qty = parseFloat(document.getElementById('nav-trade-qty').value)||0;
    var price = parseFloat(document.getElementById('nav-trade-price').value)||0;
    document.getElementById('nav-trade-preview').textContent = qty&&price ? 'Total: '+navFmt$(qty*price) : 'Total: —';
  };
  document.getElementById('nav-trade-qty').oninput = update;
  document.getElementById('nav-trade-price').oninput = update;
}
function navCloseTradeModal() {
  var m=document.getElementById('nav-trade-modal'); if(m) m.style.display='none';
}
function navSaveTrade() {
  var asset = document.getElementById('nav-trade-asset').value;
  var dir   = document.getElementById('nav-trade-dir').value;
  var date  = document.getElementById('nav-trade-date').value;
  var qty   = parseFloat(document.getElementById('nav-trade-qty').value);
  var price = parseFloat(document.getElementById('nav-trade-price').value);
  var notes = document.getElementById('nav-trade-notes').value.trim();
  if (!asset||!date||!qty||qty<=0||!price||price<=0) { alert('Fill in all fields.'); return; }
  var data = navLoad();
  data.trades.push({id:Date.now().toString(),asset,direction:dir,date,qty,price,notes,ts:Date.now()});
  navSave(data);
  navCloseTradeModal();
  renderNavDashboard();
  renderNavAgentContext();
}
function navDeleteTrade(id) {
  if (!confirm('Delete this trade?')) return;
  var data = navLoad();
  data.trades = data.trades.filter(function(t){return t.id!==id;});
  navSave(data);
  renderNavDashboard();
}

// ══════════════════════════════════════════════════════════════════════════
// CIO AGENT SIDEBAR (persistent right panel)
// ══════════════════════════════════════════════════════════════════════════
function renderNavAgentContext() {
  var q = getNavRegimeCoords();
  if (!q) return;
  var modelWeights = getModelWeights();
  var data = navLoad();
  var positions = computePositions(data.trades);
  var prices = data.prices || {};
  var REGIME_AVG = {Expansion:3.0,Deflation:2.3,Reflation:3.6,Stagflation:2.0};

  // Build full context
  var totalValue=0, totalCost=0;
  Object.keys(positions).forEach(function(asset) {
    var p=positions[asset], cp=prices[asset]?prices[asset].price:p.costBasis;
    totalValue+=p.qty*cp; totalCost+=p.qty*p.costBasis;
  });

  var today = new Date().toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  var holdings = Object.values(modelWeights).sort(function(a,b){return b.weight-a.weight;});
  var avgDur = REGIME_AVG[q.quadrant]||3;

  var ctx = [
    'MARC NAV SNAPSHOT — ' + today,
    '═══════════════════════════════',
    'REGIME: ' + q.quadrant.toUpperCase(),
    'Coords: X=' + q.rx.toFixed(4) + ' | Y=' + q.ry.toFixed(4),
    'Source: ' + (navState.liveCoords ? 'Live Regime Calc' : 'Last backtest quarter'),
    'Avg duration: ' + avgDur + 'Q',
    '',
    'MODEL PORTFOLIO (α=' + params.alpha + ', N=' + Math.round(params.n) + ', β=' + params.mcbeta + '):',
  ].concat(holdings.map(function(h){
    return '  ' + h.asset + ': ' + (h.weight*100).toFixed(1) + '%';
  }));

  if (Object.keys(positions).length) {
    ctx.push('', 'ACTUAL HOLDINGS:');
    Object.keys(positions).forEach(function(asset) {
      var p=positions[asset], cp=prices[asset]?prices[asset].price:p.costBasis;
      var val=p.qty*cp, actualPct=totalValue>0?val/totalValue:0;
      var mw=modelWeights[asset]?modelWeights[asset].weight:0;
      ctx.push('  '+asset+': '+navFmtQty(p.qty)+' @ $'+cp.toFixed(2)
        +' = '+navFmt$(val)+' (actual: '+(actualPct*100).toFixed(1)+'% | model: '+(mw*100).toFixed(1)+'%)');
    });
    ctx.push('', 'PORTFOLIO NAV: ' + navFmt$(totalValue));
    ctx.push('TOTAL P&L: ' + (totalPnl>=0?'+':'') + navFmt$(totalPnl||0));
  } else {
    ctx.push('', 'No actual holdings recorded yet.');
  }
  ctx.push('═══════════════════════════════');

  var contextBox = document.getElementById('nav-agent-context-box');
  if (contextBox) contextBox.textContent = ctx.join('\n');

  var totalPnl = totalValue - totalCost;
}

async function navRunAgent() {
  var context = document.getElementById('nav-agent-context-box')?.textContent || '';
  var extraCtx = document.getElementById('nav-agent-extra')?.value?.trim() || '';
  var btn = document.getElementById('nav-agent-run-btn');
  var output = document.getElementById('nav-agent-output');
  var ts = document.getElementById('nav-agent-ts');

  btn.disabled=true; btn.textContent='Analysing…';
  output.className=''; output.style.display='block';
  output.innerHTML='<div style="color:var(--subtle);font-family:var(--mono);font-size:11px;animation:navPulse 1.4s ease-in-out infinite;">Reading portfolio state…</div>';
  ts.textContent='';

  var systemPrompt = 'You are MARC\'s CIO agent — a sharp macro strategist with full visibility of the current portfolio state.\n\n'
    +'MARC quadrants: Expansion(X\u22650,Y<0)=equities/crypto | Reflation(X\u22650,Y\u22650)=equities/commodities | Stagflation(X<0,Y\u22650)=gold/energy | Deflation(X<0,Y<0)=bonds/cash\n\n'
    +'RULES: Max 350 words. Every sentence needs a number or asset name. Use markdown.\n\n'
    +'FORMAT:\n## Regime Assessment\n## Portfolio Alignment\n## Actions\n## Risk';

  var userMsg = context + (extraCtx ? '\n\nContext: ' + extraCtx : '');

  try {
    var endpoint = PROXY_URL ? PROXY_URL + 'ai' : 'https://api.anthropic.com/v1/messages';
    var r = await fetch(endpoint, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:800,
        system:systemPrompt, messages:[{role:'user',content:userMsg}]})
    });
    var data = await r.json();
    if (data.error) throw new Error(data.error.message);
    output.innerHTML = renderMarkdown(data.content[0].text);
    ts.textContent = 'Analysed ' + new Date().toLocaleTimeString();
  } catch(e) {
    output.innerHTML = '<div style="color:var(--red);">⚠ ' + e.message + '</div>';
  }
  btn.disabled=false; btn.textContent='▶ Run Analysis';
}

// ══════════════════════════════════════════════════════════════════════════
// EXPORT / CLEAR
// ══════════════════════════════════════════════════════════════════════════
function navExport() {
  var data = navLoad();
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({exported:new Date().toISOString(),...data},null,2)],{type:'application/json'}));
  a.download = 'marc-nav-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
}
function navClear() {
  if (!confirm('Clear ALL trade history? Cannot be undone.')) return;
  localStorage.removeItem('marc_nav');
  renderNavDashboard();
  renderNavAgentContext();
}

// ═══════════════════════════════════════
// MARKDOWN RENDERER
// ═══════════════════════════════════════
function renderMarkdown(text) {
  var h = text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  h = h.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  h = h.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  h = h.replace(/^# (.+)$/gm,'<h2>$1</h2>');
  h = h.replace(/^---+$/gm,'<hr>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
  h = h.replace(/\*([^*\n]+)\*/g,'<em>$1</em>');
  h = h.replace(/`([^`\n]+)`/g,'<code>$1</code>');
  h = h.replace(/((?:^[ \t]*[-*] [^\n]+\n?)+)/gm,function(m){
    return '<ul>'+m.trim().split('\n').map(function(l){return '<li>'+l.replace(/^[ \t]*[-*] /,'')+'</li>';}).join('')+'</ul>';
  });
  h = h.replace(/((?:^[ \t]*\d+\. [^\n]+\n?)+)/gm,function(m){
    return '<ol>'+m.trim().split('\n').map(function(l){return '<li>'+l.replace(/^[ \t]*\d+\. /,'')+'</li>';}).join('')+'</ol>';
  });
  var lines = h.split('\n'), out = [], i = 0;
  while (i < lines.length) {
    var line = lines[i];
    if (line.match(/^\|/) && i+1 < lines.length && lines[i+1].match(/^\|[-| :]+\|/)) {
      var hdrCells = line.split('|').slice(1,-1).map(function(s){return '<th>'+s.trim()+'</th>';}).join('');
      i += 2;
      var rows = '';
      while (i < lines.length && lines[i].match(/^\|/)) {
        rows += '<tr>'+lines[i].split('|').slice(1,-1).map(function(s){return '<td>'+s.trim()+'</td>';}).join('')+'</tr>';
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
// TRADE LOG DRAWER
// ═══════════════════════════════════════
function toggleTradeLog() {
  var drawer = document.getElementById('nav-tradelog-drawer');
  if (!drawer) return;
  var open = drawer.style.display === 'flex';
  drawer.style.display = open ? 'none' : 'flex';
  var btn = document.getElementById('nav-tradelog-btn');
  if (btn) btn.style.borderColor = open ? '' : 'var(--green)';
  if (btn) btn.style.color = open ? '' : 'var(--green)';
  if (!open) renderTradeLogDrawer();
}

function renderTradeLogDrawer() {
  var data = navLoad();
  var trades = data.trades || [];
  var filterSel = document.getElementById('nav-tradelog-filter');
  var sortSel   = document.getElementById('nav-tradelog-sort');
  var countEl   = document.getElementById('nav-tradelog-count');
  var tbody     = document.getElementById('nav-tradelog-tbody');
  if (!tbody) return;

  // Populate asset filter dropdown
  var assets = [...new Set(trades.map(function(t){return t.asset;}))].sort();
  if (filterSel) {
    var curFilter = filterSel.value;
    filterSel.innerHTML = '<option value="all">All assets</option>'
      + assets.map(function(a){return '<option value="'+a+'"'+(a===curFilter?' selected':'')+'>'+a+'</option>';}).join('');
  }

  // Filter + sort
  var filter = filterSel ? filterSel.value : 'all';
  var sortOrder = sortSel ? sortSel.value : 'desc';
  var filtered = filter === 'all' ? trades.slice() : trades.filter(function(t){return t.asset===filter;});
  filtered.sort(function(a,b){ return sortOrder==='desc' ? b.ts-a.ts : a.ts-b.ts; });

  if (countEl) countEl.textContent = filtered.length + ' trade' + (filtered.length!==1?'s':'');

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="padding:30px;text-align:center;color:var(--subtle);font-family:var(--mono);font-size:11px;">No trades recorded yet</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(function(t) {
    var dc = t.direction==='buy'?'var(--green)':'var(--red)';
    var db = t.direction==='buy'?'var(--green-dim)':'var(--red-dim)';
    var total = t.qty * t.price;
    var ao = window.RAW.assets.find(function(a){return a.asset===t.asset;});
    var type = ao ? ao.type : '';
    return '<tr style="border-bottom:1px solid var(--border);" onmouseover="this.style.background=\'var(--surface2)\'" onmouseout="this.style.background=\'\'">'
      +'<td style="padding:7px 14px;font-family:var(--mono);font-size:10px;color:var(--muted);">'+t.date+'</td>'
      +'<td style="padding:7px 14px;"><span style="font-weight:600;font-size:11px;">'+t.asset+'</span>'
      +(type?'<span class="badge badge-'+type+'" style="margin-left:5px;">'+type.slice(0,3)+'</span>':'')+'</td>'
      +'<td style="padding:7px 14px;text-align:center;"><span style="font-family:var(--mono);font-size:9px;font-weight:700;padding:2px 8px;border-radius:2px;background:'+db+';color:'+dc+';">'+t.direction.toUpperCase()+'</span></td>'
      +'<td style="padding:7px 14px;text-align:right;font-family:var(--mono);font-size:11px;">'+navFmtQty(t.qty)+'</td>'
      +'<td style="padding:7px 14px;text-align:right;font-family:var(--mono);font-size:11px;">$'+t.price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})+'</td>'
      +'<td style="padding:7px 14px;text-align:right;font-family:var(--mono);font-size:11px;font-weight:600;">'+navFmt$(total)+'</td>'
      +'<td style="padding:7px 14px;font-size:10px;color:var(--muted);font-style:italic;">'+(t.notes||'—')+'</td>'
      +'<td style="padding:7px 14px;text-align:center;"><button onclick="navDeleteTrade(\''+t.id+'\')" style="background:none;border:none;color:var(--subtle);cursor:pointer;font-size:11px;padding:0;" title="Delete">✕</button></td>'
      +'</tr>';
  }).join('');
}

// ═══════════════════════════════════════
// MTD / YTD METRICS
// ═══════════════════════════════════════
function computePerformanceMetrics(trades, prices) {
  var now = new Date();
  var mtdStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
  var ytdStart = new Date(now.getFullYear(), 0, 1).toISOString().slice(0,10);

  function calcPeriodPnl(fromDate) {
    // Cost basis of trades from this period
    var pos = {};
    // Build full position first (all time)
    trades.forEach(function(t) {
      if (!pos[t.asset]) pos[t.asset] = {qty:0, costBasis:0};
      var p = pos[t.asset];
      if (t.direction==='buy') {
        var nq = p.qty + t.qty;
        p.costBasis = nq > 0 ? (p.costBasis*p.qty + t.price*t.qty)/nq : 0;
        p.qty = nq;
      } else {
        p.qty = Math.max(0, p.qty - t.qty);
      }
    });
    // Calculate P&L for period trades
    var periodBuyCost = 0, periodBuyValue = 0;
    trades.filter(function(t){ return t.date >= fromDate && t.direction==='buy'; }).forEach(function(t) {
      var cp = prices[t.asset] ? prices[t.asset].price : t.price;
      periodBuyCost  += t.qty * t.price;
      periodBuyValue += t.qty * cp;
    });
    if (periodBuyCost === 0) return null;
    return {pnl: periodBuyValue - periodBuyCost, pct: (periodBuyValue-periodBuyCost)/periodBuyCost};
  }

  return {
    mtd: computePeriodReturn(trades, prices, mtdStart),
    ytd: computePeriodReturn(trades, prices, ytdStart)
  };
}

function computePeriodReturn(trades, prices, fromDate) {
  var periodTrades = trades.filter(function(t){ return t.date >= fromDate; });
  if (!periodTrades.length) return null;
  var cost = 0, currentVal = 0;
  periodTrades.forEach(function(t) {
    var cp = prices[t.asset] ? prices[t.asset].price : t.price;
    if (t.direction === 'buy') {
      cost += t.qty * t.price;
      currentVal += t.qty * cp;
    } else {
      cost -= t.qty * t.price;
      currentVal -= t.qty * cp;
    }
  });
  if (cost <= 0) return null;
  return {pnl: currentVal-cost, pct: (currentVal-cost)/cost};
}

// ═══════════════════════════════════════
// FRED AUTO-FILL
// ═══════════════════════════════════════
async function navAutoFillFRED() {
  var btn = document.getElementById('nav-fred-btn');
  if (btn) { btn.textContent = '⟳ Loading…'; btn.disabled = true; }

  try {
    var r = await fetch(PROXY_URL.replace(/\/+$/, '') + '/fred');
    var d = await r.json();

    if (d.error) throw new Error(d.error);

    // Fill inputs
    var fill = function(id, val) {
      var el = document.getElementById(id);
      if (el && val != null) el.value = parseFloat(val).toFixed(4);
    };
    fill('nav-rc-gdp',    d.gdp);
    fill('nav-rc-pmi',    d.pmi);
    fill('nav-rc-unemp',  d.unemp);
    fill('nav-rc-retail', d.retail);
    fill('nav-rc-cpi',    d.cpi);
    fill('nav-rc-pce',    d.pce);

    // Show data age
    var res = document.getElementById('nav-rc-result');
    if (res) res.innerHTML = '<div style="margin-top:6px;padding:6px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;font-family:var(--mono);font-size:9px;color:var(--subtle);">FRED data loaded — latest available releases<br>Click ↻ Compute to calculate regime</div>';

    // Auto-compute
    navComputeRegime();
  } catch(e) {
    var res = document.getElementById('nav-rc-result');
    if (res) res.innerHTML = '<div style="margin-top:6px;padding:6px 8px;background:var(--red-dim);border:1px solid var(--red);border-radius:3px;font-family:var(--mono);font-size:9px;color:var(--red);">FRED fetch failed: '+e.message+'<br>Deploy updated worker with FRED_API_KEY</div>';
  }

  if (btn) { btn.textContent = '⟳ FRED Auto-fill'; btn.disabled = false; }
}

// ═══════════════════════════════════════
// ALL-ASSET MARKET OVERVIEW TABLE
// ═══════════════════════════════════════
function renderAllAssetTable(positions, prices, modelWeights, totalValue) {
  var tbody = document.getElementById('nav-holdings-tbody');
  if (!tbody) return;

  var TC = {Equity:'#4D9FFF',ETF:'#A78BFA',Crypto:'#FFB020',Commodity:'#00D68F'};
  var allAssets = window.RAW.assets;

  var rows = allAssets.map(function(ao) {
    var p = positions[ao.asset];
    var pd = prices[ao.asset];
    var mh = modelWeights[ao.asset];
    var cp = pd ? pd.price : (p ? p.costBasis : null);
    var c24 = pd ? pd.change24h : null;
    var value = p && cp ? p.qty * cp : 0;
    var cost  = p ? p.qty * p.costBasis : 0;
    var pnl   = value - cost;
    var pnlPct = cost > 0 ? pnl/cost : 0;
    var actualPct = totalValue > 0 && p ? value/totalValue : 0;
    var mw = mh ? mh.weight : 0;
    var delta = actualPct - mw;
    var hasPos = p && p.qty > 0.000001;
    var hasLive = !!pd;
    return {asset:ao.asset, ao, p, cp, c24, value, cost, pnl, pnlPct,
            actualPct, mw, delta, hasPos, hasLive, type:ao.type};
  });

  // Sort: positions first by value, then model holdings, then rest by type
  rows.sort(function(a,b) {
    if (a.hasPos && !b.hasPos) return -1;
    if (!a.hasPos && b.hasPos) return 1;
    if (a.hasPos && b.hasPos) return b.value - a.value;
    if (a.mw && !b.mw) return -1;
    if (!a.mw && b.mw) return 1;
    return a.asset.localeCompare(b.asset);
  });

  tbody.innerHTML = rows.map(function(r) {
    var dc = Math.abs(r.delta)<0.02?'var(--green)':Math.abs(r.delta)<0.05?'var(--amber)':'var(--red)';
    var pc = r.pnl>=0?'var(--green)':'var(--red)';
    var cc = r.c24!=null?(r.c24>=0?'var(--green)':'var(--red)'):'var(--subtle)';
    var tc = TC[r.type]||'#888';
    var rowOpacity = r.hasPos ? '' : r.mw > 0 ? 'opacity:0.75;' : 'opacity:0.4;';
    var priceStr = r.cp != null ? navFmt$(r.cp) : '—';
    var dotCls = r.hasLive ? 'live' : 'stale';

    return '<tr style="border-bottom:1px solid var(--border);'+rowOpacity+'" '
      +'onmouseover="this.style.background=\'var(--surface2)\';this.style.opacity=\'1\';" '
      +'onmouseout="this.style.background=\'\';this.style.opacity=\''+( r.hasPos?'1':r.mw>0?'0.75':'0.4')+'\';">'
      +'<td style="padding:5px 10px;">'
        +'<span style="font-weight:600;font-size:11px;">'+r.asset+'</span>'
        +'<span class="badge badge-'+r.type+'" style="margin-left:5px;font-size:9px;color:'+tc+';">'+r.type.slice(0,3)+'</span>'
        +(r.hasPos?'<span style="margin-left:5px;width:5px;height:5px;border-radius:50%;background:var(--green);display:inline-block;"></span>':'')
      +'</td>'
      // Qty
      +'<td style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:10px;color:var(--muted);">'+(r.hasPos?navFmtQty(r.p.qty):'—')+'</td>'
      // Avg cost
      +'<td style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:10px;color:var(--muted);">'+(r.hasPos?'$'+r.p.costBasis.toFixed(2):'—')+'</td>'
      // Live price — shown for ALL assets
      +'<td style="padding:5px 10px;"><div class="live-price"><span class="live-dot '+dotCls+'"></span><span style="font-family:var(--mono);font-size:12px;font-weight:600;color:'+(r.hasLive?'var(--text)':'var(--muted)')+';">'+priceStr+'</span></div></td>'
      // 24h
      +'<td style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:11px;color:'+cc+';">'
        +(r.c24!=null?(r.c24>=0?'+':'')+r.c24.toFixed(2)+'%':'—')+'</td>'
      // Value
      +'<td style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:11px;font-weight:600;">'+(r.hasPos?navFmt$(r.value):'—')+'</td>'
      // P&L
      +'<td class="pnl-cell" style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:10px;color:'+pc+';">'
        +(r.hasPos?(r.pnl>=0?'+':'')+navFmt$(r.pnl)+'<br><span class="pnl-pct">'+(r.pnlPct>=0?'+':'')+(r.pnlPct*100).toFixed(1)+'%</span>':'—')+'</td>'
      // Actual %
      +'<td style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:11px;">'+(r.hasPos?(r.actualPct*100).toFixed(1)+'%':'—')+'</td>'
      // Model %
      +'<td style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:11px;color:'+tc+';">'+(r.mw>0?(r.mw*100).toFixed(1)+'%':'—')+'</td>'
      // Delta
      +'<td style="padding:5px 10px;text-align:right;font-family:var(--mono);font-size:11px;font-weight:600;color:'+dc+';">'
        +((r.mw>0||r.hasPos)?(r.delta>=0?'+':'')+(r.delta*100).toFixed(1)+'%':'—')+'</td>'
      // Actions
      +'<td style="padding:5px 10px;text-align:center;">'
        +'<button onclick="navOpenTradeModal(\''+r.asset+'\',\'buy\')" style="font-size:9px;background:var(--green-dim);border:1px solid var(--green-mid);color:var(--green);padding:2px 5px;border-radius:2px;cursor:pointer;margin-right:2px;">B</button>'
        +(r.hasPos?'<button onclick="navOpenTradeModal(\''+r.asset+'\',\'sell\')" style="font-size:9px;background:var(--red-dim);border:1px solid var(--red);color:var(--red);padding:2px 5px;border-radius:2px;cursor:pointer;">S</button>':'')
      +'</td>'
      +'</tr>';
  }).join('');
}
