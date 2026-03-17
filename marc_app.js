// ═══════════════════════════════════════════════════════════════
// MARC Strategy Lab — Application Logic
// Edit this file to fix bugs or add features.
// Requires marc_data.js to be loaded first (defines window.RAW).
// ═══════════════════════════════════════════════════════════════
// FUNCTION INDEX:
//   filterByDates()       — filter results to date window
//   initAssetConstraints()— build left panel sliders
//   computeWeights()      — proximity + constraint engine  [~line 100]
//   _doBacktest()         — full backtest run              [~line 140]
//   calcStats()           — Sharpe/CAGR/DD/Sortino        [~line 195]
//   runOptimise()         — parameter search               [~line 215]
//   renderCumReturn()     — cumulative return chart        [~line 270]
//   renderRiver()         — attribution river              [~line 295]
//   renderHeatmap()       — monthly heatmap               [~line 310]
//   renderYearCards()     — year breakdown tab             [~line 380]
//   openSnap()            — portfolio snapshot modal       [~line 420]
//   renderSensitivity()   — sensitivity heatmap            [~line 550]
//   updateRightPanel()    — right panel KPIs + verdict     [~line 580]
//   refreshAll()          — re-render everything           [~line 680]
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════
// DATA
// ═══════════════════════════════════════
const ALL_MONTHS    = RAW.months;
const ALL_RESULTS   = RAW.results;
const ALL_QUARTERLY = RAW.quarterly;
const ASSETS        = RAW.assets;
const ASSET_MONTHLY = RAW.asset_monthly;
const MONTHLY_ATTR  = RAW.monthly_attr;

const RC  = {Expansion:'#00D68F',Deflation:'#4D9FFF',Reflation:'#FFB020',Stagflation:'#FF4D6D'};
const RBG = {Expansion:'rgba(0,214,143,0.07)',Deflation:'rgba(77,159,255,0.07)',Reflation:'rgba(255,176,32,0.07)',Stagflation:'rgba(255,77,109,0.07)'};
const TC  = {Equity:'#4D9FFF',ETF:'#A78BFA',Crypto:'#FFB020',Commodity:'#00D68F'};
const CC  = ['#FF6B9D','#00E5FF','#B9FF66','#FF9A3C','#E040FB','#FFFF00'];

// ═══════════════════════════════════════
// STATE
// ═══════════════════════════════════════
let params      = {alpha:1.0, mcbeta:0.0, n:15};
let lockedParams = {alpha:false, mcbeta:false, n:false};
let sectorCaps  = {Equity:1, ETF:1, Crypto:1, Commodity:1};
let regimeCalcCoords = null; // set by Regime Calculator tab
let assetCaps   = {};   // 0..1
let assetFloors = {};   // 0..1
let comparisons = [];
let quarterly   = JSON.parse(JSON.stringify(ALL_QUARTERLY));
let btResults   = JSON.parse(JSON.stringify(ALL_RESULTS));
btResults._ma   = MONTHLY_ATTR;
let startDate   = '2010-01';
let endDate     = '2026-03';
let logScale    = false;
let sensiCache  = {};
let showElig    = false;
let guideOpen   = true;

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════
const pct  = (v,d=1) => (v>=0?'+':'')+((v||0)*100).toFixed(d)+'%';
const xpct = (v,d=1) => ((v||0)*100).toFixed(d)+'%';
const fx   = (v,d=2) => (v||0).toFixed(d);

function filterByDates(results, ma) {
  const rows = [], mas = [];
  for (let i=0;i<results.length;i++) {
    if (results[i].month >= startDate && results[i].month <= endDate) {
      rows.push(results[i]);
      mas.push(ma ? ma[i]||{} : {});
    }
  }
  return {filtered:rows, filteredMa:mas};
}

// ═══════════════════════════════════════
// MARC AGENT PANEL
// ═══════════════════════════════════════

function buildFullAgentContext() {
  // ── Regime ──────────────────────────────────────────────────────
  const q = getCurrentRegimeCoords();
  if (!q) return 'No regime data available.';
  const REGIME_AVG = {Expansion:3.0, Deflation:2.3, Reflation:3.6, Stagflation:2.0};
  const avgDur = REGIME_AVG[q.quadrant] || 3;

  // Regime duration (consecutive quarters)
  const qKeys = Object.keys(quarterly).filter(qk=>qk>=startDate&&qk<=endDate).sort();
  let duration = 0;
  for (let i=qKeys.length-1; i>=0; i--) {
    const qq = quarterly[qKeys[i]] || ALL_QUARTERLY[qKeys[i]];
    if (qq?.quadrant === q.quadrant) duration++;
    else break;
  }
  const durStatus = duration >= avgDur
    ? 'EXTENDED — ' + duration + 'Q (avg ' + avgDur + 'Q) — elevated transition risk'
    : 'Normal — ' + duration + 'Q of avg ' + avgDur + 'Q — regime likely to persist';

  // Last 6 quarters path
  const last6 = qKeys.slice(-6).map(qk => {
    const qq = quarterly[qk] || ALL_QUARTERLY[qk];
    return '  ' + qk + ': ' + qq?.quadrant + ' (X=' + qq?.rx?.toFixed(2) + ', Y=' + qq?.ry?.toFixed(2) + ')';
  }).join('\n');

  // ── Performance stats ────────────────────────────────────────────
  const {filtered, filteredMa} = filterByDates(btResults, btResults._ma || MONTHLY_ATTR);
  const stats = calcStats(filtered);
  const totalRet = filtered.length ? filtered[filtered.length-1].port_cum / (filtered[0].port_cum/(1+filtered[0].port_ret)) : 1;

  // ── Regime mix ───────────────────────────────────────────────────
  const regC = {};
  for (const r of filtered) regC[r.quadrant] = (regC[r.quadrant]||0) + 1;
  const regMix = Object.entries(regC)
    .sort((a,b)=>b[1]-a[1])
    .map(([k,v]) => k + ': ' + (v/filtered.length*100).toFixed(0) + '% (' + v + ' months)')
    .join(' | ');

  // ── Model verdict ────────────────────────────────────────────────
  const qKeysFull = [...new Set(filtered.map(r=>r.quarter))];
  let wins = 0, verdictTotal = 0;
  for (const qk of qKeysFull) {
    const qq = quarterly[qk] || ALL_QUARTERLY[qk];
    if (!qq || !qq.holdings) continue;
    const qMas = [];
    for (let i=0; i<filtered.length; i++) if (filtered[i].quarter===qk) qMas.push(filteredMa[i]||{});
    const hSorted = [...qq.holdings].sort((a,b)=>a.dist-b.dist);
    if (hSorted.length < 2) continue;
    const half = Math.ceil(hSorted.length/2);
    const close = hSorted.slice(0,half).map(h=>h.asset);
    const far   = hSorted.slice(half).map(h=>h.asset);
    const cR = qMas.reduce((s,ma)=>s+close.reduce((ss,a)=>ss+(ma[a]||0),0),0)/Math.max(qMas.length,1);
    const fR = qMas.reduce((s,ma)=>s+far.reduce((ss,a)=>ss+(ma[a]||0),0),0)/Math.max(qMas.length,1);
    if (cR > fR) wins++;
    verdictTotal++;
  }
  const verdictPct = verdictTotal > 0 ? Math.round(wins/verdictTotal*100) : 0;

  // ── Model portfolio ──────────────────────────────────────────────
  const lastQk = Object.keys(ALL_QUARTERLY).filter(qk=>qk<=endDate).sort().pop() || endDate;
  const avail = ASSETS.filter(a=>a.first_data && a.first_data<=lastQk).map(a=>a.asset);
  const excluded = ASSETS.filter(a=>!avail.includes(a.asset)).map(a=>a.asset);
  const holdings = computeWeights(q.rx, q.ry, avail, params.alpha, params.mcbeta, params.n);

  // Sector breakdown
  const sectorTotals = {};
  for (const h of holdings) sectorTotals[h.type] = (sectorTotals[h.type]||0) + h.weight;

  // ── Contributors / detractors ────────────────────────────────────
  const totals = {};
  for (const ma of filteredMa) for (const [a,v] of Object.entries(ma)) totals[a] = (totals[a]||0)+v;
  const sortedC = Object.entries(totals).sort((a,b)=>b[1]-a[1]);
  const topContribs = sortedC.filter(([,v])=>v>0).slice(0,6)
    .map(([a,v]) => '  ' + a + ': +' + (v*100).toFixed(1) + '%');
  const topDetract = sortedC.filter(([,v])=>v<0).slice(0,4)
    .map(([a,v]) => '  ' + a + ': ' + (v*100).toFixed(1) + '%');

  // ── Churn ────────────────────────────────────────────────────────
  const rebalRows = filtered.filter(r=>r.l1>0);
  const avgChurn = rebalRows.length > 0
    ? rebalRows.reduce((s,r)=>s+r.l1,0)/rebalRows.length : 0;

  // ── Active constraints ───────────────────────────────────────────
  const activeSC = Object.entries(sectorCaps).filter(([,v])=>v<1)
    .map(([k,v])=>k+'='+Math.round(v*100)+'%');
  const activeCap = Object.entries(assetCaps).filter(([,v])=>v<1)
    .map(([k,v])=>k+' max '+Math.round(v*100)+'%');
  const activeFlr = Object.entries(assetFloors).filter(([,v])=>v>0)
    .map(([k,v])=>k+' min '+Math.round(v*100)+'%');
  const constraintStr = [...activeSC,...activeCap,...activeFlr].join(', ') || 'None active';

  // ── Assemble full briefing ────────────────────────────────────────
  const today = new Date().toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  const lines = [
    '╔══════════════════════════════════════════════╗',
    '║         MARC FULL MODEL BRIEFING             ║',
    '║  ' + today.padEnd(44) + '║',
    '╚══════════════════════════════════════════════╝',
    '',
    '━━━ CURRENT MACRO REGIME ━━━━━━━━━━━━━━━━━━━━━━',
    'Quadrant:   ' + q.quadrant.toUpperCase(),
    'Coordinates: X (Growth) = ' + q.rx.toFixed(4) + '  |  Y (Inflation) = ' + q.ry.toFixed(4),
    'Duration:   ' + durStatus,
    '',
    'Quadrant definitions:',
    '  Expansion  (X≥0, Y<0) — high growth, low inflation',
    '  Reflation  (X≥0, Y≥0) — rising growth + rising inflation',
    '  Stagflation(X<0, Y≥0) — low growth, high inflation',
    '  Deflation  (X<0, Y<0) — low growth, low inflation',
    '',
    '━━━ RECENT REGIME PATH (last 6 quarters) ━━━━━━',
    last6,
    '',
    '━━━ BACKTEST PERFORMANCE (' + startDate + ' → ' + endDate + ') ━━',
    'Total Return:  +' + (totalRet*100-100).toFixed(0) + '%  (' + totalRet.toFixed(1) + 'x)',
    'CAGR:          +' + (stats.cagr*100).toFixed(1) + '% per year',
    'Sharpe Ratio:  ' + stats.sharpe.toFixed(2),
    'Sortino Ratio: ' + stats.sortino.toFixed(2),
    'Max Drawdown:  -' + (stats.mdd*100).toFixed(1) + '%',
    'Calmar Ratio:  ' + stats.calmar.toFixed(2),
    'Avg Churn/Qtr: ' + (avgChurn*100).toFixed(0) + '% (L1 turnover at each rebalance)',
    '',
    '━━━ REGIME HISTORY (full backtest window) ━━━━━',
    regMix,
    '',
    '━━━ MODEL VALIDITY SCORE ━━━━━━━━━━━━━━━━━━━━━━',
    'Proximity Verdict: ' + verdictPct + '% of ' + verdictTotal + ' quarters — closest assets outperformed distant',
    verdictPct >= 60
      ? '→ STRONG signal: proximity scoring has genuine predictive power in this dataset'
      : verdictPct >= 50
      ? '→ MODERATE signal: some predictive power, use with caution'
      : '→ WEAK signal: model may not be well-calibrated for this period',
    '',
    '━━━ MODEL PARAMETERS ━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'Alpha (α):  ' + params.alpha + '  — proximity sharpness (higher = more concentrated near regime centroid)',
    'Top N:      ' + Math.round(params.n) + '  — assets selected each quarter',
    'mcBeta (β): ' + params.mcbeta + '  — market cap tilt (0 = pure proximity, 1 = full cap-weighted)',
    '',
    '━━━ CURRENT MODEL PORTFOLIO ━━━━━━━━━━━━━━━━━━━',
    'Regime coords: (' + q.rx.toFixed(4) + ', ' + q.ry.toFixed(4) + ')  |  Assets: ' + holdings.length + ' of ' + avail.length + ' eligible',
    '',
    'Holdings (ranked by weight):',
    ...holdings.map((h,i) =>
      '  ' + (i+1).toString().padStart(2) + '. ' +
      h.asset.padEnd(14) +
      (h.type.slice(0,3)).padEnd(5) +
      'dist=' + h.dist.toFixed(2).padEnd(7) +
      (h.weight*100).toFixed(1) + '%'
    ),
    '',
    'Sector allocation:',
    ...Object.entries(sectorTotals).sort((a,b)=>b[1]-a[1])
      .map(([t,w]) => '  ' + t.padEnd(12) + (w*100).toFixed(1) + '%'),
    '',
    '━━━ HISTORICAL CONTRIBUTORS (full window) ━━━━━',
    'Top performers:',
    ...topContribs,
    'Underperformers:',
    ...topDetract,
    '',
    '━━━ ASSET UNIVERSE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'Eligible now:  ' + avail.length + ' of ' + ASSETS.length + ' assets',
    excluded.length > 0
      ? 'Excluded (' + excluded.length + ' — insufficient history): ' + excluded.join(', ')
      : 'All assets eligible',
    '',
    '━━━ ACTIVE CONSTRAINTS ━━━━━━━━━━━━━━━━━━━━━━━━',
    constraintStr,
    '',
    '══════════════════════════════════════════════',
  ];

  return lines.join('\n');
}

// Keep old name for backward compat
function buildAgentSnapshot() { return buildFullAgentContext(); }

function openAgentPanel() {
  const context = buildFullAgentContext();
  const box = document.getElementById('agent-snapshot-box');
  if (box) box.textContent = context;
  const savedKey = sessionStorage.getItem('marc_agent_key');
  if (savedKey) {
    const inp = document.getElementById('agent-api-key');
    if (inp) inp.value = savedKey;
  }
  document.getElementById('agent-panel').classList.add('open');
}

function closeAgentPanel() {
  document.getElementById('agent-panel').classList.remove('open');
}

function exportForAgent() { openAgentPanel(); }

async function runMarcAgent() {
  const apiKey = document.getElementById('agent-api-key').value.trim();
  const context = document.getElementById('agent-context').value.trim();
  const actualHoldings = document.getElementById('agent-holdings').value.trim();

  if (!apiKey) return alert('Please enter your Anthropic API key.');
  sessionStorage.setItem('marc_agent_key', apiKey);

  const fullContext = buildFullAgentContext();

  const btn    = document.getElementById('agent-run-btn');
  const output = document.getElementById('agent-output');
  const wrap   = document.getElementById('agent-output-wrap');
  const ts     = document.getElementById('agent-ts');

  btn.disabled = true; btn.textContent = 'Analysing\u2026';
  wrap.style.display = 'block';
  output.className = 'thinking';
  output.textContent = 'Reading full model state\u2026';
  ts.textContent = '';

  const systemPrompt = `You are the MARC portfolio agent — an expert macro strategist deeply integrated with the MARC Macro Regime Framework.

MARC classifies the economy into four quadrants using normalised macro indicators:
  X axis = Growth score  (GDP, PMI, Unemployment, Retail Sales)
  Y axis = Inflation score (CPI, PCE)

  Expansion   (X\u22650, Y<0)  — high growth, low inflation  \u2192 equities, crypto, growth
  Reflation   (X\u22650, Y\u22650)  — rising growth + inflation  \u2192 equities, real assets, commodities
  Stagflation (X<0,  Y\u22650)  — low growth, high inflation  \u2192 gold, commodities, energy, short bonds
  Deflation   (X<0,  Y<0)  — low growth, low inflation   \u2192 bonds, cash, defensives

You receive a FULL MODEL BRIEFING that includes regime history, backtest performance, model validity score, current portfolio, contributors, detractors, constraints, and asset universe.

Your job is to deliver a deeply integrated analysis that uses ALL of this context. Be specific, analytical, and direct. Use numbers. Reference the actual data given.

Format your response with these exact section headers:

REGIME ASSESSMENT
PORTFOLIO ALIGNMENT
KEY RISKS & MISALIGNMENTS
RECOMMENDED ACTIONS
FORWARD OUTLOOK`;

  const holdingsStr = actualHoldings
    ? ('\n\nUSER\'S ACTUAL HOLDINGS (compare against model):\n' + actualHoldings + '\n\nCalculate the delta between actual and model. Flag the biggest mismatches.')
    : '\n\nNo actual holdings provided — analyse the model portfolio and regime positioning.';

  const userMsg = fullContext + holdingsStr + (context ? '\n\nUSER CONTEXT: ' + context : '');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-allow-browser': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }]
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    output.className = '';
    output.textContent = data.content[0].text;
    ts.textContent = 'Analysed at ' + new Date().toLocaleTimeString();
  } catch(err) {
    output.className = 'error';
    output.textContent = '\u26a0 Error: ' + err.message + '\n\nCommon causes:\n\u2022 API key wrong or expired\n\u2022 No API credits (check console.anthropic.com)\n\u2022 Network issue';
  }
  btn.disabled = false; btn.textContent = '\u25b6 Run Analysis';
}

// ═══════════════════════════════════════
// INIT UI
// ═══════════════════════════════════════
function initAssetConstraints() {
  const wrap = document.getElementById('asset-constraints');
  let html = '';
  for (const type of ['Crypto','Equity','Commodity','ETF']) {
    const group = ASSETS.filter(a=>a.type===type);
    html += `<div class="acon-group-hdr" style="color:${TC[type]};">${type}</div>`;
    for (const a of group) {
      html += `<div class="acon-row">
        <div class="acon-name"><span>${a.asset}</span><span class="badge badge-${a.type}">${a.type.slice(0,3)}</span></div>
        <div class="acon-sl">
          <span class="acon-type" style="color:var(--green);">min</span>
          <input type="range" min="0" max="100" step="1" value="0" id="af-${a.asset}" style="accent-color:var(--green);" oninput="setFloor('${a.asset}',this.value)"/>
          <span class="acon-v" id="afv-${a.asset}" style="color:var(--green);">0%</span>
        </div>
        <div class="acon-sl">
          <span class="acon-type" style="color:var(--red);">max</span>
          <input type="range" min="0" max="100" step="1" value="100" id="ac-${a.asset}" style="accent-color:var(--red);" oninput="setCap('${a.asset}',this.value)"/>
          <span class="acon-v" id="acv-${a.asset}" style="color:var(--red);">100%</span>
        </div>
      </div>`;
    }
  }
  wrap.innerHTML = html;
}

function initCompSelect() {
  const s = document.getElementById('comp-select');
  s.innerHTML = '<option value="">Add benchmark…</option>' +
    ASSETS.map(a=>`<option value="${a.asset}">${a.asset}</option>`).join('');
}

function setFloor(asset, val) { assetFloors[asset]=+val/100; document.getElementById(`afv-${asset}`).textContent=val+'%'; }
function setCap(asset, val)   { assetCaps[asset]=+val/100;   document.getElementById(`acv-${asset}`).textContent=val+'%'; }
function updateSectorCap(type, val) { sectorCaps[type]=+val/100; document.getElementById(`scapv-${type}`).textContent=val+'%'; }
function liveParam(key, val) {
  if(lockedParams[key]) return;
  params[key]=parseFloat(val);
  document.getElementById(`dv-${key}`).textContent = key==='n' ? Math.round(params.n) : params[key].toFixed(2);
}

function toggleLock(key) {
  lockedParams[key]=!lockedParams[key];
  const btn=document.getElementById(`lock-${key}`);
  const slider=document.getElementById(`sl-${key}`);
  if(lockedParams[key]){
    btn.textContent='🔒';btn.style.borderColor='var(--amber)';btn.style.color='var(--amber)';
    slider.style.opacity='0.4';slider.disabled=true;
  } else {
    btn.textContent='🔓';btn.style.borderColor='var(--border)';btn.style.color='var(--subtle)';
    slider.style.opacity='1';slider.disabled=false;
  }
}

function addComparison() {
  const s=document.getElementById('comp-select'), asset=s.value; if(!asset) return;
  if(comparisons.find(c=>c.asset===asset)) return;
  comparisons.push({asset, color:CC[comparisons.length%CC.length]});
  s.value=''; renderCompList();
  sensiCache={};_doBacktest(params.alpha,params.mcbeta,params.n);renderCumReturn();
}
function removeComparison(asset) {
  comparisons=comparisons.filter(c=>c.asset!==asset); renderCompList();
  sensiCache={};_doBacktest(params.alpha,params.mcbeta,params.n);renderCumReturn();
}
function renderCompList() {
  const el=document.getElementById('comp-list');
  if(!comparisons.length){el.innerHTML=`<div style="font-size:10px;color:var(--subtle);">None added</div>`;return;}
  el.innerHTML=comparisons.map(c=>`<div class="comp-row">
    <div class="comp-dot" style="background:${c.color};"></div>
    <span class="comp-name">${c.asset}</span>
    <button class="comp-remove" onclick="removeComparison('${c.asset}')">×</button>
  </div>`).join('');
}

// ═══════════════════════════════════════
// WEIGHT ENGINE
// ═══════════════════════════════════════
function computeWeights(rx, ry, availAssets, alpha, mcBeta, N) {
  const eps=0.1;
  N=Math.max(1,Math.min(Math.round(N),availAssets.length));
  const scored=[];
  for (const a of ASSETS) {
    if(!availAssets.includes(a.asset)) continue;
    if((sectorCaps[a.type]||1)<=0) continue; // sector hard-excluded
    const dist=Math.hypot(a.x-rx, a.y-ry);
    const score=(1/(Math.pow(dist,alpha)+eps))*Math.pow(a.confMult,mcBeta);
    const cap  =assetCaps[a.asset]   !== undefined ? assetCaps[a.asset]   : 1;
    const floor=assetFloors[a.asset] !== undefined ? assetFloors[a.asset] : 0;
    scored.push({asset:a.asset,score,dist,type:a.type,x:a.x,y:a.y,cap,floor});
  }
  const eligible=scored.filter(s=>s.cap>0);
  eligible.sort((a,b)=>b.score-a.score);
  const top=eligible.slice(0,N);
  // Force-include floored assets not in top-N
  for (const s of eligible) if(s.floor>0 && !top.find(h=>h.asset===s.asset)) top.push(s);
  const sum=top.reduce((s,x)=>s+x.score,0);
  for (const h of top) h.weight=sum>0?h.score/sum:1/top.length;
  // Iterative projection
  for (let iter=0;iter<20;iter++) {
    let changed=false;
    for(const h of top){
      if(h.weight<h.floor-1e-9){h.weight=h.floor;changed=true;}
      if(h.weight>h.cap+1e-9)  {h.weight=h.cap;  changed=true;}
    }
    const st={};
    for(const h of top) st[h.type]=(st[h.type]||0)+h.weight;
    for(const[type,tot] of Object.entries(st)){
      const cap=sectorCaps[type]||1;
      if(tot>cap+1e-9){const sc=cap/tot;for(const h of top)if(h.type===type){h.weight*=sc;changed=true;}}
    }
    const total=top.reduce((s,h)=>s+h.weight,0);
    if(Math.abs(total-1)>1e-9){const f=total>0?1/total:1;for(const h of top)h.weight*=f;changed=true;}
    if(!changed) break;
  }
  return top.filter(h=>h.weight>1e-6).sort((a,b)=>b.weight-a.weight);
}

// ═══════════════════════════════════════
// BACKTEST ENGINE
// ═══════════════════════════════════════
function _doBacktest(alpha, mcBeta, N) {
  const qKeys=Object.keys(ALL_QUARTERLY).sort();
  const newQ={};
  for (const qk of qKeys) {
    const q=ALL_QUARTERLY[qk];
    const avail=ASSETS.filter(a=>a.first_data&&a.first_data<=qk).map(a=>a.asset);
    const holdings=computeWeights(q.rx,q.ry,avail,alpha,mcBeta,N);
    newQ[qk]={...q,holdings,avail_count:avail.length};
  }
  quarterly=newQ;
  const newMA=[], newResults=[];
  let prevQk=null, prevW={};
  for (let i=0;i<ALL_RESULTS.length;i++) {
    const orig=ALL_RESULTS[i], qk=orig.quarter;
    const w=Object.fromEntries((newQ[qk]?.holdings||[]).map(h=>[h.asset,h.weight]));
    let pr=0;
    const ma={};
    for(const[a,wt] of Object.entries(w)){const ret=ASSET_MONTHLY[a]?(ASSET_MONTHLY[a][i]||0):0;pr+=wt*ret;ma[a]=wt*ret;}
    newMA.push(ma);
    let l1=0,swaps=0;
    if(qk!==prevQk){
      const allA=new Set([...Object.keys(w),...Object.keys(prevW)]);
      for(const a of allA)l1+=Math.abs((w[a]||0)-(prevW[a]||0));
      swaps=[...Object.keys(w)].filter(a=>!prevW[a]).length;
      prevW={...w};prevQk=qk;
    }
    newResults.push({...orig,port_ret:pr,l1,swaps});
  }
  // Cum returns
  let pc=1,sc=1,bc=1;
  const compCums={};
  for(const c of comparisons)compCums[c.asset]=1;
  for(let i=0;i<newResults.length;i++){
    const r=newResults[i];
    pc*=(1+r.port_ret);r.port_cum=pc;
    sc*=(1+(r.spy_ret||0));r.spy_cum=sc;
    bc*=(1+(r.btc_ret||0));r.btc_cum=bc;
    for(const c of comparisons){
      const ret=ASSET_MONTHLY[c.asset]?(ASSET_MONTHLY[c.asset][i]||0):0;
      compCums[c.asset]*=(1+ret);
      r[`comp_${c.asset}`]=compCums[c.asset];
    }
  }
  btResults=newResults;
  btResults._ma=newMA;
}

function runBacktest() {
  // Force-sync date inputs before running — prevents stale dates if user
  // changes the picker and immediately clicks Run without blurring first
  const sd=document.getElementById('start-date').value;
  const ed=document.getElementById('end-date').value;
  if(sd) startDate=sd;
  if(ed) endDate=ed;
  const btn=document.getElementById('run-btn');
  btn.disabled=true;btn.textContent='Computing…';
  setTimeout(()=>{sensiCache={};_doBacktest(params.alpha,params.mcbeta,params.n);btn.disabled=false;btn.textContent='▶  Run Backtest';refreshAll();},20);
}

// ═══════════════════════════════════════
// STATS
// ═══════════════════════════════════════
function calcStats(results) {
  if(!results.length)return{};
  const rets=results.map(r=>r.port_ret), n=rets.length;
  const mean=rets.reduce((s,x)=>s+x,0)/n;
  const std=Math.sqrt(rets.map(x=>(x-mean)**2).reduce((s,x)=>s+x,0)/Math.max(n-1,1));
  const sharpe=std>0?(mean/std)*Math.sqrt(12):0;
  const dn=rets.filter(r=>r<0);
  const dd2=dn.length>0?Math.sqrt(dn.map(r=>r*r).reduce((s,x)=>s+x,0)/dn.length):1e-9;
  const sortino=mean/dd2*Math.sqrt(12);
  const baseCum=results[0].port_cum/(1+results[0].port_ret);
  const totalRet=results[results.length-1].port_cum/baseCum-1;
  const cagr=Math.pow(results[results.length-1].port_cum/baseCum,12/n)-1;
  let peak=baseCum,mdd=0;
  for(const r of results){if(r.port_cum>peak)peak=r.port_cum;const d=(peak-r.port_cum)/peak;if(d>mdd)mdd=d;}
  const calmar=mdd>0?cagr/mdd:0;
  const rebalRows=results.filter(r=>r.l1>0);
  const avgL1=rebalRows.length>0?rebalRows.reduce((s,r)=>s+r.l1,0)/rebalRows.length:0;
  return{totalRet,cagr,sharpe,sortino,calmar,mdd,best:Math.max(...rets),worst:Math.min(...rets),avgL1,n};
}
function objScore(stats,obj){if(!stats||stats.cagr===undefined)return-Infinity;return{sharpe:stats.sharpe,cagr:stats.cagr,calmar:stats.calmar,sortino:stats.sortino,turnover:-stats.avgL1}[obj]??stats.sharpe;}

// ═══════════════════════════════════════
// OPTIMISER
// ═══════════════════════════════════════
function runOptimise() {
  const btn=document.getElementById('opt-btn'),obj=document.getElementById('opt-obj').value;
  const sf=parseFloat(document.getElementById('sharpe-floor').value)||0;
  btn.disabled=true;btn.textContent='…';
  document.getElementById('opt-status').textContent=sf>0?`Searching (Sharpe ≥ ${sf})…`:'Searching…';
  setTimeout(()=>{
    const alphas=lockedParams.alpha?[params.alpha]:[0.2,0.5,0.8,1.0,1.5,2.0,3.0,4.0];
    const betas=lockedParams.mcbeta?[params.mcbeta]:[0,0.25,0.5,0.75,1.0];
    const ns=lockedParams.n?[params.n]:[5,8,10,12,15,18,20];
    let best={score:-Infinity,alpha:1,mcbeta:0,n:15,sharpe:0};let feasible=0;
    for(const a of alphas)for(const b of betas)for(const n of ns){
      _doBacktest(a,b,n);
      const{filtered}=filterByDates(btResults,null);
      const stats=calcStats(filtered);
      if(sf>0&&stats.sharpe<sf)continue;
      feasible++;
      const s=objScore(stats,obj);
      if(s>best.score)best={score:s,alpha:a,mcbeta:b,n,sharpe:stats.sharpe};
    }
    if(!feasible){
      document.getElementById('opt-status').textContent=`✗ No params with Sharpe ≥ ${sf}. Try lower floor.`;
      btn.disabled=false;btn.textContent='⚡ Go';
      _doBacktest(params.alpha,params.mcbeta,params.n);return;
    }
    params={alpha:best.alpha,mcbeta:best.mcbeta,n:best.n};
    ['alpha','mcbeta','n'].forEach(k=>{document.getElementById(`sl-${k}`).value=params[k];liveParam(k,params[k]);});
    sensiCache={};_doBacktest(best.alpha,best.mcbeta,best.n);
    const sc=obj==='cagr'||obj==='turnover'?(best.score*100).toFixed(1)+'%':best.score.toFixed(2);
    const note=sf>0?`  Sharpe=${best.sharpe.toFixed(2)}`:'';
    document.getElementById('opt-status').textContent=`✓ ${obj}: ${sc}  α=${best.alpha} N=${best.n}${note}`;
    btn.disabled=false;btn.textContent='⚡ Go';refreshAll();
  },30);
}

// ═══════════════════════════════════════
// PLOTLY CONFIG
// ═══════════════════════════════════════
const PL=(extra={})=>({
  paper_bgcolor:'rgba(0,0,0,0)',plot_bgcolor:'rgba(0,0,0,0)',
  font:{family:"'DM Mono',monospace",size:9,color:'#8888AA'},
  margin:{l:46,r:10,t:5,b:28},
  xaxis:{gridcolor:'#1A1A2A',linecolor:'#2A2A3A',tickfont:{size:8},zeroline:false},
  yaxis:{gridcolor:'#1A1A2A',linecolor:'#2A2A3A',tickfont:{size:8},zeroline:false},
  legend:{bgcolor:'rgba(0,0,0,0)',bordercolor:'rgba(0,0,0,0)',font:{size:8},orientation:'h',y:-0.2},
  hovermode:'x unified',...extra
});
const CFG={displayModeBar:false,responsive:true};

function regimeShapes(filtered) {
  const shapes=[];let cur=null,start=null;
  for(const r of filtered){
    if(r.quadrant!==cur){
      if(cur&&start)shapes.push({type:'rect',xref:'x',yref:'paper',x0:start,x1:r.month,y0:0,y1:1,fillcolor:RBG[cur]||'rgba(0,0,0,0)',line:{width:0}});
      cur=r.quadrant;start=r.month;
    }
  }
  if(cur&&start)shapes.push({type:'rect',xref:'x',yref:'paper',x0:start,x1:filtered[filtered.length-1].month,y0:0,y1:1,fillcolor:RBG[cur]||'rgba(0,0,0,0)',line:{width:0}});
  return shapes;
}

// ═══════════════════════════════════════
// CHARTS
// ═══════════════════════════════════════

// LOG TOGGLE
function toggleLog(){
  logScale=!logScale;
  const b=document.getElementById('log-toggle');
  b.style.background=logScale?'var(--amber-dim)':'var(--surface2)';
  b.style.borderColor=logScale?'var(--amber)':'var(--border)';
  b.style.color=logScale?'var(--amber)':'var(--muted)';
  renderCumReturn();
}

function renderCumReturn() {
  const{filtered}=filterByDates(btResults,null);
  if(!filtered.length)return;
  // Prepend a synthetic start point so chart always opens at 0% / 1.0x
  const baseCum=filtered[0].port_cum/(1+filtered[0].port_ret);
  const startLabel=filtered[0].month.slice(0,4)+'-'+(parseInt(filtered[0].month.slice(5,7))-1).toString().padStart(2,'0');
  const x=[startLabel,...filtered.map(r=>r.month)];
  const indexed=[1,...filtered.map(r=>r.port_cum/baseCum)];
  const y=logScale?indexed:indexed.map(v=>(v-1)*100);
  const shapes=regimeShapes(filtered);
  const traces=[{x,y,name:'Strategy',type:'scatter',mode:'lines',line:{color:'#F0EFF8',width:2.5},hovertemplate:logScale?'%{y:.2f}x<extra>Strategy</extra>':'%{y:.1f}%<extra>Strategy</extra>'}];
  // Benchmarks — rebased to same window start, with synthetic zero point
  for(const c of comparisons){
    const si=ALL_MONTHS.indexOf(filtered[0].month);
    const bBase=si>0?(filtered[0][`comp_${c.asset}`]||1)/(1+(ASSET_MONTHLY[c.asset]?ASSET_MONTHLY[c.asset][si]||0:0)):1;
    const cy=[logScale?1:0,...filtered.map(r=>{const idx=(r[`comp_${c.asset}`]||1)/bBase;return logScale?idx:(idx-1)*100;})];
    traces.push({x,y:cy,name:c.asset,type:'scatter',mode:'lines',line:{color:c.color,width:1.5,dash:'dot'},hovertemplate:logScale?`%{y:.2f}x<extra>${c.asset}</extra>`:`%{y:.1f}%<extra>${c.asset}</extra>`});
  }
  const totalRet=(indexed[indexed.length-1]-1)*100;
  document.getElementById('cum-meta').textContent=`${filtered[0].month} → ${filtered[filtered.length-1].month}  ·  ${totalRet>=0?'+':''}${totalRet.toFixed(1)}%${logScale?' · LOG':''}`;
  const yax=logScale?{...PL().yaxis,type:'log',tickformat:'.2f'}:{...PL().yaxis,ticksuffix:'%'};
  Plotly.react('chart-cumret',traces,{...PL({shapes}),yaxis:yax},CFG);
  // Regime strip
  const strip=document.getElementById('regime-strip');
  strip.innerHTML=filtered.map(r=>`<div style="flex:1;background:${RC[r.quadrant]||'#444'};opacity:0.7;" title="${r.month}: ${r.quadrant}"></div>`).join('');
}

function renderRiver() {
  const{filtered,filteredMa}=filterByDates(btResults,btResults._ma||MONTHLY_ATTR);
  if(!filtered.length)return;
  const x=filtered.map(r=>r.month);
  const totals={};
  for(const ma of filteredMa)for(const[a,v] of Object.entries(ma))totals[a]=(totals[a]||0)+v;
  // Only show assets currently held in last quarter of window
  const qKeys=Object.keys(quarterly).filter(qk=>qk>=startDate&&qk<=endDate).sort();
  const lastQk=qKeys[qKeys.length-1];
  const currentHoldings=new Set((quarterly[lastQk]?.holdings||[]).map(h=>h.asset));
  const sortedAssets=Object.entries(totals)
    .filter(([a,v])=>currentHoldings.has(a)&&Math.abs(v)>0.0001)
    .sort((a,b)=>b[1]-a[1]).map(([k])=>k);
  const traces=[];
  for(const asset of sortedAssets){
    const col=TC[ASSETS.find(a=>a.asset===asset)?.type]||'#888';
    traces.push({x,y:filteredMa.map(ma=>(ma[asset]||0)*100),name:asset,type:'scatter',mode:'none',fill:traces.length===0?'tozeroy':'tonexty',fillcolor:col+'44',line:{color:col,width:0.5},hovertemplate:`${asset}: %{y:.2f}%<extra></extra>`,stackgroup:'one'});
  }
  Plotly.react('chart-river',traces,{...PL({margin:{l:46,r:10,t:4,b:28}}),yaxis:{...PL().yaxis,ticksuffix:'%'},showlegend:false},CFG);
  // Click river → asset cap popup
  setTimeout(()=>{
    const el=document.getElementById('chart-river');
    if(el._riverBound)return; el._riverBound=true;
    el.on('plotly_click',e=>{if(e.points[0])showAssetCapPopup(e.points[0].data.name,e.event);});
  },200);
}

function renderHeatmap() {
  const{filtered}=filterByDates(btResults,null);
  const years=[...new Set(filtered.map(r=>r.month.slice(0,4)))].sort();
  const MN=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const z=[],text=[];
  for(const yr of years){
    const row=[],rowT=[];
    for(let m=1;m<=12;m++){
      const key=`${yr}-${String(m).padStart(2,'0')}`;
      const r=filtered.find(x=>x.month===key);
      if(r){row.push(r.port_ret*100);rowT.push((r.port_ret*100).toFixed(1)+'%');}
      else{row.push(null);rowT.push('');}
    }
    z.push(row);text.push(rowT);
  }
  Plotly.react('chart-heatmap',[{z,x:MN,y:years,type:'heatmap',colorscale:[[0,'#FF4D6D'],[0.3,'#3D0014'],[0.5,'#13131A'],[0.7,'#003D28'],[1,'#00D68F']],zmid:0,zmin:-20,zmax:20,text,texttemplate:'%{text}',textfont:{size:7,color:'#F0EFF8'},showscale:false,hovertemplate:'%{y} %{x}: %{z:.1f}%<extra></extra>'}],{...PL({margin:{l:32,r:8,t:4,b:28}}),xaxis:{...PL().xaxis,side:'bottom'},yaxis:{...PL().yaxis,autorange:'reversed'}},CFG);
}

function renderDrawdown() {
  const{filtered}=filterByDates(btResults,null);
  if(!filtered.length)return;
  const x=filtered.map(r=>r.month);
  let peak=filtered[0].port_cum/(1+filtered[0].port_ret);
  const dd=[];
  for(const r of filtered){if(r.port_cum>peak)peak=r.port_cum;dd.push(-((peak-r.port_cum)/peak)*100);}
  const maxDD=Math.min(...dd);
  document.getElementById('dd-meta').textContent=`Max DD: ${maxDD.toFixed(1)}%`;
  Plotly.react('chart-dd',[{x,y:dd,type:'scatter',mode:'lines',fill:'tozeroy',line:{color:'#FF4D6D',width:1},fillcolor:'rgba(255,77,109,0.15)',hovertemplate:'%{y:.1f}%<extra>Drawdown</extra>'}],{...PL({margin:{l:46,r:10,t:4,b:28}}),yaxis:{...PL().yaxis,ticksuffix:'%'}},CFG);
}

function renderRolling() {
  const{filtered}=filterByDates(btResults,null);
  if(filtered.length<12)return;
  const x=[],y=[];
  for(let i=12;i<filtered.length;i++){
    const window=filtered.slice(i-12,i);
    const base=window[0].port_cum/(1+window[0].port_ret);
    const rolling=(window[window.length-1].port_cum/base-1)*100;
    x.push(filtered[i].month);y.push(rolling);
  }
  const shapes=regimeShapes(filtered.slice(12));
  const cols=y.map(v=>v>=0?'rgba(0,214,143,0.7)':'rgba(255,77,109,0.7)');
  Plotly.react('chart-rolling',[{x,y,type:'bar',marker:{color:cols},hovertemplate:'%{x}: %{y:.1f}%<extra>12m return</extra>'}],{...PL({margin:{l:46,r:10,t:4,b:28},shapes}),yaxis:{...PL().yaxis,ticksuffix:'%'},showlegend:false},CFG);
}

function renderTurnover() {
  const{filtered}=filterByDates(btResults,null);
  if(!filtered.length)return;
  const rebal=filtered.filter(r=>r.l1>0);
  if(!rebal.length)return;
  const x=rebal.map(r=>r.quarter||r.month), y=rebal.map(r=>r.l1*100);
  const avg=y.reduce((s,v)=>s+v,0)/y.length;
  Plotly.react('chart-turnover',[
    {x,y,type:'bar',marker:{color:'rgba(255,176,32,0.6)',line:{color:RC.Reflation,width:0.5}},hovertemplate:'%{x}: %{y:.1f}%<extra>Churn</extra>'},
    {x:[x[0],x[x.length-1]],y:[avg,avg],type:'scatter',mode:'lines',line:{color:'#8888AA',width:1,dash:'dot'},name:'avg',hovertemplate:`Avg: ${avg.toFixed(1)}%<extra></extra>`}
  ],{...PL({margin:{l:46,r:10,t:4,b:28}}),yaxis:{...PL().yaxis,ticksuffix:'%'},showlegend:false},CFG);
}

// ═══════════════════════════════════════
// YEAR BREAKDOWN
// ═══════════════════════════════════════
function renderYearCards() {
  const{filtered,filteredMa}=filterByDates(btResults,btResults._ma||MONTHLY_ATTR);
  const years=[...new Set(filtered.map(r=>r.month.slice(0,4)))].sort();
  let html='';
  for(const yr of years){
    const yRows=filtered.filter(r=>r.month.startsWith(yr));
    const yMas=[];
    for(let i=0;i<filtered.length;i++) if(filtered[i].month.startsWith(yr)) yMas.push(filteredMa[i]||{});
    if(!yRows.length)continue;
    const baseCum=yRows[0].port_cum/(1+yRows[0].port_ret);
    const ret=yRows[yRows.length-1].port_cum/baseCum-1;
    const regC={};for(const r of yRows)regC[r.quadrant]=(regC[r.quadrant]||0)+1;
    const regBar=Object.entries(regC).map(([reg,cnt])=>`<div class="yr-rseg" style="width:${cnt/yRows.length*100}%;background:${RC[reg]};"></div>`).join('');
    const totals={};for(const ma of yMas)for(const[a,v] of Object.entries(ma))totals[a]=(totals[a]||0)+v;
    const top2=Object.entries(totals).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([k])=>k).join(', ');
    const quarters=[...new Set(yRows.map(r=>r.quarter))];
    let qRows='';
    for(const qk of quarters){
      const qMon=yRows.filter(r=>r.quarter===qk);
      const qMas=[];for(let i=0;i<filtered.length;i++)if(filtered[i].quarter===qk&&filtered[i].month.startsWith(yr))qMas.push(filteredMa[i]||{});
      const qBase=qMon[0].port_cum/(1+qMon[0].port_ret);
      const qRet=qMon[qMon.length-1].port_cum/qBase-1;
      const qTotals={};for(const ma of qMas)for(const[a,v] of Object.entries(ma))qTotals[a]=(qTotals[a]||0)+v;
      const qTop=Object.entries(qTotals).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k])=>k).join(', ');
      const reg=qMon[0].quadrant;
      qRows+=`<div class="qrow" onclick="openSnap('${qk}')">
        <span class="qrow-d">${qk}</span>
        <span class="qrow-r ${qRet>=0?'pos':'neg'}">${pct(qRet,1)}</span>
        <span class="qrow-a">${qTop}</span>
        <span class="qrow-reg" style="color:${RC[reg]||'#888'}">${reg.slice(0,3).toUpperCase()}</span>
      </div>`;
    }
    html+=`<div class="yr-card">
      <div class="yr-hdr" onclick="toggleYear('${yr}')">
        <span class="yr-num">${yr}</span>
        <span class="yr-ret ${ret>=0?'pos':'neg'}">${pct(ret,1)}</span>
        <div class="yr-rbar">${regBar}</div>
        <span class="yr-top">${top2}</span>
      </div>
      <div class="yr-expand" id="ye-${yr}">${qRows}</div>
    </div>`;
  }
  document.getElementById('year-cards').innerHTML=html;
}
function toggleYear(yr){document.getElementById(`ye-${yr}`).classList.toggle('open');}

// ═══════════════════════════════════════
// PORTFOLIO SNAPSHOT MODAL
// ═══════════════════════════════════════
function openSnap(qk) {
  const q=quarterly[qk]||ALL_QUARTERLY[qk]; if(!q)return;
  document.getElementById('snap-title').textContent=`Portfolio — ${qk}  ·  ${q.quadrant}`;
  // KPIs for this quarter
  const{filtered,filteredMa}=filterByDates(btResults,btResults._ma||MONTHLY_ATTR);
  const qMons=filtered.filter(r=>r.quarter===qk);
  const qMas=[];for(let i=0;i<filtered.length;i++)if(filtered[i].quarter===qk)qMas.push(filteredMa[i]||{});
  let qRet=0;
  if(qMons.length){const base=qMons[0].port_cum/(1+qMons[0].port_ret);qRet=qMons[qMons.length-1].port_cum/base-1;}
  const qStats=calcStats(qMons);
  // Contribution this quarter per asset
  const qContrib={};for(const ma of qMas)for(const[a,v] of Object.entries(ma))qContrib[a]=(qContrib[a]||0)+v;
  document.getElementById('snap-kpis').innerHTML=`
    <div class="snap-kpi"><div class="snap-kpi-v" style="color:${qRet>=0?'var(--green)':'var(--red)'}">${pct(qRet,1)}</div><div class="snap-kpi-l">Quarter Return</div></div>
    <div class="snap-kpi"><div class="snap-kpi-v" style="color:var(--blue)">${fx(qStats.sharpe||0)}</div><div class="snap-kpi-l">Sharpe</div></div>
    <div class="snap-kpi"><div class="snap-kpi-v" style="color:var(--amber)">${(q.holdings||[]).length}</div><div class="snap-kpi-l">Holdings</div></div>
    <div class="snap-kpi"><div class="snap-kpi-v" style="color:var(--purple)">${q.avail_count||'—'}</div><div class="snap-kpi-l">Assets Eligible</div></div>`;
  const maxW=Math.max(...(q.holdings||[]).map(h=>h.weight));
  let rows=`<div class="snap-row snap-row-hdr"><span>#</span><span>Asset</span><span>Weight</span><span>Contrib</span><span>Allocation</span></div>`;
  (q.holdings||[]).forEach((h,i)=>{
    const contrib=qContrib[h.asset]||0;
    const col=TC[h.type]||'#888';
    rows+=`<div class="snap-row">
      <span style="font-family:var(--mono);font-size:10px;color:var(--subtle);">${i+1}</span>
      <span style="display:flex;align-items:center;gap:6px;"><span style="font-weight:600;font-size:11px;">${h.asset}</span><span class="badge badge-${h.type}">${h.type.slice(0,3)}</span></span>
      <span style="font-family:var(--mono);font-size:12px;font-weight:500;color:${col};">${xpct(h.weight,1)}</span>
      <span style="font-family:var(--mono);font-size:11px;color:${contrib>=0?'var(--green)':'var(--red)'};">${contrib>=0?'+':''}${(contrib*100).toFixed(2)}%</span>
      <span><div class="wbar"><div class="wbar-fill" style="width:${h.weight/maxW*100}%;background:${col};"></div></div></span>
    </div>`;
  });
  document.getElementById('snap-holdings').innerHTML=rows;
  document.getElementById('snap-modal').style.display='flex';
}
function closeSnap(){document.getElementById('snap-modal').style.display='none';}

// Asset cap popup from river click
function showAssetCapPopup(assetName, event) {
  const cur=assetCaps[assetName]!==undefined?assetCaps[assetName]*100:100;
  const x=event.clientX+10, y=event.clientY-20;
  // Remove existing
  document.querySelectorAll('.cap-popup').forEach(el=>el.remove());
  const div=document.createElement('div');
  div.className='cap-popup';
  div.style.cssText=`position:fixed;z-index:300;left:${Math.min(x,window.innerWidth-220)}px;top:${Math.max(y,10)}px;background:var(--surface);border:1px solid var(--border2);border-radius:4px;padding:12px;width:210px;box-shadow:0 8px 32px rgba(0,0,0,.5);`;
  const a=ASSETS.find(x=>x.asset===assetName);
  div.innerHTML=`<div style="font-size:11px;font-weight:600;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">${assetName} <span class="badge badge-${a?.type}">${a?.type||''}</span><button onclick="this.closest('.cap-popup').remove()" style="background:none;border:none;color:var(--subtle);cursor:pointer;font-size:15px;line-height:1;">×</button></div>
    <div style="font-size:10px;color:var(--muted);margin-bottom:7px;">Max allocation cap</div>
    <div style="display:flex;gap:8px;align-items:center;">
      <input type="range" min="0" max="100" step="1" value="${cur}" style="flex:1;accent-color:var(--red);" oninput="setCap('${assetName}',this.value);document.getElementById('ac-${assetName}').value=this.value;document.getElementById('acv-${assetName}').textContent=this.value+'%';this.nextElementSibling.textContent=this.value+'%'"/>
      <span style="font-family:var(--mono);font-size:13px;min-width:36px;">${cur}%</span>
    </div>
    <div style="font-size:9px;color:var(--subtle);margin-top:7px;">0% = excluded · 100% = unconstrained</div>`;
  document.body.appendChild(div);
  setTimeout(()=>document.addEventListener('click',function h(e){if(!div.contains(e.target)){div.remove();document.removeEventListener('click',h);}},true),200);
}

// ═══════════════════════════════════════
// ATTRIBUTION TAB
// ═══════════════════════════════════════
function renderAttributionTab() {
  const{filtered,filteredMa}=filterByDates(btResults,btResults._ma||MONTHLY_ATTR);
  const totals={};
  for(const ma of filteredMa)for(const[a,v] of Object.entries(ma))totals[a]=(totals[a]||0)+v;
  const sorted=Object.entries(totals).sort((a,b)=>b[1]-a[1]);
  const names=sorted.map(([k])=>k), vals=sorted.map(([,v])=>v*100);
  const cols=names.map(n=>TC[ASSETS.find(a=>a.asset===n)?.type]||'#888');
  Plotly.react('chart-attr-bar',[{x:names,y:vals,type:'bar',marker:{color:cols,opacity:0.8},hovertemplate:'%{x}: %{y:.1f}%<extra></extra>'}],{...PL({margin:{l:46,r:10,t:6,b:50}}),xaxis:{...PL().xaxis,tickangle:-45,tickfont:{size:8}},yaxis:{...PL().yaxis,ticksuffix:'%'},showlegend:false},CFG);
  setTimeout(()=>{
    const el=document.getElementById('chart-attr-bar');
    if(el._attrBound)return;el._attrBound=true;
    el.on('plotly_click',e=>{if(e.points[0])showAssetCapPopup(e.points[0].x,e.event);});
  },200);
  const maxAbs=Math.max(...vals.map(Math.abs));
  const rows=sorted.map(([asset,contrib])=>{
    const pctV=(contrib*100).toFixed(2);const isPos=contrib>=0;
    const bw=maxAbs>0?Math.abs(contrib)/maxAbs*80:0;
    const bar=isPos?`<span class="bpos" style="width:${bw}px;"></span>`:`<span class="bneg" style="width:${bw}px;"></span>`;
    const a=ASSETS.find(x=>x.asset===asset);
    return`<tr><td style="font-weight:500;">${asset} <button onclick="showAssetCapPopup('${asset}',{clientX:200,clientY:200})" style="background:none;border:1px solid var(--border);border-radius:2px;color:var(--subtle);cursor:pointer;padding:1px 5px;font-size:9px;margin-left:3px;">cap</button></td><td><span class="badge badge-${a?.type}">${a?.type||'—'}</span></td><td style="font-family:var(--mono);text-align:right;color:${isPos?'var(--green)':'var(--red)'};">${isPos?'+':''}${pctV}%</td><td>${bar}</td></tr>`;
  }).join('');
  document.getElementById('attr-table-wrap').innerHTML=`<table class="attr-table"><thead><tr><th>Asset</th><th>Type</th><th>Total Contrib</th><th>Impact</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ═══════════════════════════════════════
// REGIME MAP
// ═══════════════════════════════════════
function renderMap() {
  const{filtered}=filterByDates(btResults,null);
  const qKeys=[...new Set(filtered.map(r=>r.quarter))].sort();
  const traces=[];
  const trailX=qKeys.map(k=>(quarterly[k]||ALL_QUARTERLY[k])?.rx);
  const trailY=qKeys.map(k=>(quarterly[k]||ALL_QUARTERLY[k])?.ry);
  const trailC=qKeys.map(k=>RC[(quarterly[k]||ALL_QUARTERLY[k])?.quadrant]||'#888');
  traces.push({x:trailX,y:trailY,mode:'lines+markers',type:'scatter',line:{color:'#2A2A3A',width:1.5},marker:{color:trailC,size:7,opacity:0.9,line:{color:'#0C0C0F',width:1}},text:qKeys.map(k=>{const q=quarterly[k]||ALL_QUARTERLY[k];const top3=(q.holdings||[]).slice(0,3).map(h=>`${h.asset} ${(h.weight*100).toFixed(0)}%`).join(', ');return`${k}<br>${q.quadrant}<br>${top3}`;}),hovertemplate:'%{text}<extra></extra>',name:'Regime trail'});
  for(const[type,grp] of Object.entries(Object.groupBy?Object.groupBy(ASSETS,a=>a.type):ASSETS.reduce((g,a)=>{(g[a.type]=g[a.type]||[]).push(a);return g;},{}))){
    traces.push({x:grp.map(a=>a.x),y:grp.map(a=>a.y),mode:'markers+text',type:'scatter',name:type,marker:{color:TC[type],size:9,opacity:0.85,line:{color:'#0C0C0F',width:1}},text:grp.map(a=>a.asset),textfont:{size:8,color:TC[type]},textposition:'top center',hovertemplate:'%{text}<extra>'+type+'</extra>'});
  }
  // Ambiguity zone circle
  const theta=Array.from({length:65},(_,i)=>i/64*2*Math.PI);
  traces.push({x:theta.map(t=>1.5*Math.cos(t)),y:theta.map(t=>1.5*Math.sin(t)),mode:'lines',type:'scatter',line:{color:'rgba(255,176,32,0.25)',width:1.5,dash:'dot'},name:'Ambiguous zone',hoverinfo:'skip',showlegend:true});
  const shapes=[
    {type:'line',xref:'x',yref:'paper',x0:0,x1:0,y0:0,y1:1,line:{color:'#2A2A3A',width:1}},
    {type:'line',xref:'paper',yref:'y',x0:0,x1:1,y0:0,y1:0,line:{color:'#2A2A3A',width:1}},
  ];
  const annotations=[
    {x:3.5,y:4.8,text:'REFLATION',showarrow:false,font:{size:9,color:RC.Reflation,family:'DM Mono'},opacity:.35},
    {x:3.5,y:-4.8,text:'EXPANSION',showarrow:false,font:{size:9,color:RC.Expansion,family:'DM Mono'},opacity:.35},
    {x:-3.5,y:4.8,text:'STAGFLATION',showarrow:false,font:{size:9,color:RC.Stagflation,family:'DM Mono'},opacity:.35},
    {x:-3.5,y:-4.8,text:'DEFLATION',showarrow:false,font:{size:9,color:RC.Deflation,family:'DM Mono'},opacity:.35},
  ];
  Plotly.react('chart-map',traces,{paper_bgcolor:'#13131A',plot_bgcolor:'#13131A',font:{family:"'DM Mono',monospace",size:9,color:'#8888AA'},margin:{l:40,r:10,t:10,b:30},xaxis:{gridcolor:'#1A1A2A',linecolor:'#2A2A3A',range:[-6.5,6.5],title:{text:'← Growth →',font:{size:9}}},yaxis:{gridcolor:'#1A1A2A',linecolor:'#2A2A3A',range:[-5.5,5.5],title:{text:'← Inflation →',font:{size:9}},scaleanchor:'x',scaleratio:1},shapes,annotations,legend:{x:0,y:1,bgcolor:'rgba(0,0,0,0)',font:{size:9}},hovermode:'closest'},CFG);
}

function toggleEligibility() {
  showElig=!showElig;
  const el=document.getElementById('chart-eligibility');
  const btn=document.getElementById('elig-btn');
  el.style.display=showElig?'block':'none';
  btn.style.color=showElig?'var(--green)':'var(--muted)';
  btn.style.borderColor=showElig?'var(--green)':'var(--border)';
  if(showElig)renderEligibility();
}

function renderEligibility() {
  const qKeys=Object.keys(ALL_QUARTERLY).filter(qk=>qk>=startDate&&qk<=endDate).sort();
  const x=qKeys, y=qKeys.map(qk=>(quarterly[qk]||ALL_QUARTERLY[qk])?.avail_count||0);
  const cols=qKeys.map(qk=>TC[{Expansion:'ETF',Deflation:'Commodity',Reflation:'Equity',Stagflation:'Crypto'}[(quarterly[qk]||ALL_QUARTERLY[qk])?.quadrant]]||'#888');
  Plotly.react('chart-eligibility',[{x,y,type:'bar',marker:{color:cols,opacity:0.7},hovertemplate:'%{x}: %{y} assets<extra></extra>'}],{...PL({margin:{l:40,r:10,t:10,b:36}}),yaxis:{...PL().yaxis,title:{text:'Eligible',font:{size:8}}},showlegend:false,title:{text:'Asset Eligibility Over Time',font:{size:10,color:'#8888AA'}}},CFG);
}

// ═══════════════════════════════════════
// SENSITIVITY
// ═══════════════════════════════════════
function renderSensitivity() {
  const metric=document.getElementById('sens-metric').value;
  let xAxis=document.getElementById('sens-x').value;
  let yAxis=document.getElementById('sens-y').value;
  if(xAxis===yAxis){yAxis=xAxis==='alpha'?'n':'alpha';document.getElementById('sens-y').value=yAxis;}
  const vals={alpha:[0.2,0.5,0.8,1.0,1.5,2.0,3.0,4.0],n:[5,8,10,12,15,18,20],mcbeta:[0,0.25,0.5,0.75,1.0]};
  const xVals=vals[xAxis],yVals=vals[yAxis];
  const fixK=Object.keys(vals).find(k=>k!==xAxis&&k!==yAxis);
  const fixV=params[fixK];
  const z=[];
  for(const yv of yVals){
    const row=[];
    for(const xv of xVals){
      const key=`${xAxis}=${xv},${yAxis}=${yv},fix=${fixK}=${fixV}`;
      if(sensiCache[key]!==undefined){row.push(sensiCache[key]);continue;}
      const p={alpha:params.alpha,n:params.n,mcbeta:params.mcbeta};p[xAxis]=xv;p[yAxis]=yv;p[fixK]=fixV;
      _doBacktest(p.alpha,p.mcbeta,p.n);
      const{filtered}=filterByDates(btResults,null);
      const s=objScore(calcStats(filtered),metric);
      sensiCache[key]=s;row.push(s);
    }
    z.push(row);
  }
  _doBacktest(params.alpha,params.mcbeta,params.n);
  const annotations=[{x:params[xAxis],y:params[yAxis],text:'✕',showarrow:false,font:{size:14,color:'#F0EFF8'}}];
  const lbl={sharpe:'Sharpe',cagr:'CAGR',calmar:'Calmar',sortino:'Sortino',mdd:'Max DD'};
  Plotly.react('chart-sensitivity',[{z,x:xVals,y:yVals,type:'heatmap',colorscale:[[0,'#FF4D6D'],[0.3,'#3D0014'],[0.5,'#13131A'],[0.7,'#003D28'],[1,'#00D68F']],colorbar:{tickfont:{size:8,color:'#8888AA'},thickness:10,len:.8},hovertemplate:`${xAxis}=%{x}, ${yAxis}=%{y}: %{z:.2f}<extra></extra>`}],{paper_bgcolor:'#13131A',plot_bgcolor:'#13131A',font:{family:"'DM Mono',monospace",size:9,color:'#8888AA'},margin:{l:50,r:80,t:30,b:50},xaxis:{title:{text:xAxis,font:{size:9}},tickfont:{size:9}},yaxis:{title:{text:yAxis,font:{size:9}},tickfont:{size:9}},annotations,title:{text:`${lbl[metric]} sensitivity · fixed: ${fixK}=${fixV}`,font:{size:10,color:'#8888AA'}}},CFG);
}

// ═══════════════════════════════════════
// RIGHT PANEL
// ═══════════════════════════════════════
function updateRightPanel() {
  const{filtered,filteredMa}=filterByDates(btResults,btResults._ma||MONTHLY_ATTR);
  if(!filtered.length)return;
  const stats=calcStats(filtered);
  document.getElementById('sk-ret').textContent=pct(stats.totalRet,1);
  document.getElementById('sk-cagr').textContent=pct(stats.cagr,1);
  document.getElementById('sk-sharpe').textContent=fx(stats.sharpe);
  document.getElementById('sk-mdd').textContent='-'+xpct(stats.mdd,1);
  document.getElementById('sk-best').textContent='+'+xpct(stats.best,1);
  document.getElementById('sk-worst').textContent=xpct(stats.worst,1);
  const isFullHistory=startDate===ALL_MONTHS[0]&&endDate===ALL_MONTHS[ALL_MONTHS.length-1];
  document.getElementById('sel-lbl').textContent=isFullHistory?'Full history':`${startDate} → ${endDate}`;
  // Topbar
  const multiple=(filtered[filtered.length-1].port_cum/(filtered[0].port_cum/(1+filtered[0].port_ret)));
  document.getElementById('ts-total').textContent=multiple.toFixed(1)+'x';
  document.getElementById('ts-cagr').textContent=pct(stats.cagr,1);
  document.getElementById('ts-sharpe').textContent=fx(stats.sharpe);
  document.getElementById('ts-mdd').textContent='-'+xpct(stats.mdd,1);
  document.getElementById('ts-sortino').textContent=fx(stats.sortino);
  document.getElementById('ts-churn').textContent=xpct(stats.avgL1,0);
  const lastR=filtered[filtered.length-1];
  const rp=document.getElementById('ts-regime');
  rp.textContent=lastR.quadrant;rp.className=`rpill rpill-${lastR.quadrant.charAt(0)}`;
  // Regime mix
  const regC={};for(const r of filtered)regC[r.quadrant]=(regC[r.quadrant]||0)+1;
  document.getElementById('regime-mix-bar').innerHTML=Object.entries(regC).map(([reg,cnt])=>`<div style="flex:${cnt};background:${RC[reg]};"></div>`).join('');
  document.getElementById('regime-mix-leg').innerHTML=Object.entries(regC).map(([reg,cnt])=>`<span style="color:${RC[reg]}">${reg.slice(0,3)} ${(cnt/filtered.length*100).toFixed(0)}%</span>`).join('');
  // Verdict
  let wins=0,total=0;const vx=[],vy=[],vt=[];
  const qKeys=[...new Set(filtered.map(r=>r.quarter))];
  for(const qk of qKeys){
    const q=quarterly[qk]||ALL_QUARTERLY[qk];if(!q||!q.holdings)continue;
    const qMons=filtered.filter(r=>r.quarter===qk);
    const qMas=[];for(let i=0;i<filtered.length;i++)if(filtered[i].quarter===qk)qMas.push(filteredMa[i]||{});
    const hSorted=[...q.holdings].sort((a,b)=>a.dist-b.dist);if(hSorted.length<2)continue;
    const half=Math.ceil(hSorted.length/2);
    const close=hSorted.slice(0,half).map(h=>h.asset),far=hSorted.slice(half).map(h=>h.asset);
    const cR=qMas.reduce((s,ma)=>s+close.reduce((ss,a)=>ss+(ma[a]||0),0),0)/Math.max(qMas.length,1);
    const fR=qMas.reduce((s,ma)=>s+far.reduce((ss,a)=>ss+(ma[a]||0),0),0)/Math.max(qMas.length,1);
    if(cR>fR)wins++;total++;
    const qTotalRet=qMons.reduce((s,r)=>s+r.port_ret,0)*100;
    vx.push(parseFloat(hSorted[0]?.dist?.toFixed(2)));vy.push(parseFloat(qTotalRet.toFixed(2)));vt.push(`${qk} ${q.quadrant}`);
  }
  const vpct=total>0?Math.round(wins/total*100):0;
  const vs=document.getElementById('verdict-score');
  vs.textContent=vpct+'%';vs.style.color=vpct>=60?'var(--green)':vpct>=45?'var(--amber)':'var(--red)';
  document.getElementById('verdict-lbl').textContent=`of ${total} quarters: closest assets beat distant`;
  Plotly.react('chart-verdict',[{x:vx,y:vy,mode:'markers',type:'scatter',marker:{color:vy.map(v=>v>=0?'#00D68F':'#FF4D6D'),size:5,opacity:.7},text:vt,hovertemplate:'%{text}<br>Dist: %{x}, Ret: %{y:.1f}%<extra></extra>'}],{paper_bgcolor:'rgba(0,0,0,0)',plot_bgcolor:'rgba(0,0,0,0)',font:{family:"'DM Mono',monospace",size:8,color:'#8888AA'},margin:{l:40,r:8,t:4,b:28},xaxis:{gridcolor:'#1A1A2A',linecolor:'#2A2A3A',tickfont:{size:8},title:{text:'Min dist to regime',font:{size:8}}},yaxis:{gridcolor:'#1A1A2A',linecolor:'#2A2A3A',tickfont:{size:8},ticksuffix:'%'},hovermode:'closest',showlegend:false},CFG);
  // Contributors / detractors
  const totals={};for(const ma of filteredMa)for(const[a,v] of Object.entries(ma))totals[a]=(totals[a]||0)+v;
  const sorted=Object.entries(totals).sort((a,b)=>b[1]-a[1]);
  const mkRow=([asset,contrib])=>{
    const a=ASSETS.find(x=>x.asset===asset);
    return`<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
      <span style="flex:1;font-size:11px;">${asset}</span>
      <span class="badge badge-${a?.type}">${a?.type?.slice(0,3)||'—'}</span>
      <span style="font-family:var(--mono);font-size:11px;min-width:48px;text-align:right;color:${contrib>=0?'var(--green)':'var(--red)'}">${contrib>=0?'+':''}${(contrib*100).toFixed(1)}%</span>
    </div>`;
  };
  document.getElementById('top-contrib').innerHTML=sorted.filter(([,v])=>v>0).slice(0,6).map(mkRow).join('');
  document.getElementById('top-detract').innerHTML=sorted.filter(([,v])=>v<0).slice(0,4).map(mkRow).join('');
  // Eligibility bar
  const qKs=[...new Set(filtered.map(r=>r.quarter))];
  const avgE=qKs.reduce((s,qk)=>s+((quarterly[qk]||ALL_QUARTERLY[qk])?.avail_count||0),0)/Math.max(qKs.length,1);
  document.getElementById('elig-count').textContent=avgE.toFixed(0)+' / '+ASSETS.length;
  document.getElementById('elig-fill').style.width=(avgE/ASSETS.length*100)+'%';
}

// ═══════════════════════════════════════
// TAB + PANEL CONTROLS
// ═══════════════════════════════════════
function showTab(id){
  document.querySelectorAll('.tab-btn').forEach((t,i)=>t.classList.toggle('active',['main','years','attribution','map','sensitivity','portfolio','regime-calc'][i]===id));
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
  document.getElementById(`tab-${id}`).classList.add('active');
  if(id==='years')renderYearCards();
  if(id==='attribution')renderAttributionTab();
  if(id==='map')renderMap();
  if(id==='sensitivity')renderSensitivity();
  if(id==='portfolio')renderPortfolio();
  setTimeout(()=>window.dispatchEvent(new Event('resize')),50);
}
function togglePanel(side){
  const el=document.getElementById(`${side}-panel`);
  el.classList.toggle('collapsed');
  const btn=document.getElementById(`${side==='left'?'l':'r'}panel-btn`);
  btn.style.opacity=el.classList.contains('collapsed')?'.5':'1';
}
function toggleGuide(){
  guideOpen=!guideOpen;
  document.getElementById('guide-body').style.display=guideOpen?'grid':'none';
  document.getElementById('guide-toggle').textContent=guideOpen?'hide':'show';
}

// ═══════════════════════════════════════
// REFRESH
// ═══════════════════════════════════════
function refreshAll(){
  renderCumReturn();renderRiver();renderHeatmap();renderDrawdown();renderRolling();renderTurnover();
  updateRightPanel();
  const active=document.querySelector('.tab-btn.active')?.textContent?.toLowerCase()?.trim()||'';
  if(active.includes('year'))renderYearCards();
  if(active.includes('attr'))renderAttributionTab();
  if(active.includes('map'))renderMap();
  if(active.includes('sens'))renderSensitivity();
  if(active.includes('portfolio')||active.includes('\u2b21'))renderPortfolio();
  if(showElig)renderEligibility();
}

// ═══════════════════════════════════════
// KEYBOARD
// ═══════════════════════════════════════
document.addEventListener('keydown',e=>{
  if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;
  if(e.key==='1')showTab('main');if(e.key==='2')showTab('years');
  if(e.key==='3')showTab('attribution');if(e.key==='4')showTab('map');
  if(e.key==='5')showTab('sensitivity');if(e.key==='6')showTab('portfolio');
  if(e.key==='7')showTab('regime-calc');
  if(e.key==='l'||e.key==='L')toggleLog();
  if(e.key==='Escape'){closeSnap();document.querySelectorAll('.cap-popup').forEach(el=>el.remove());}
});

function onDateChange(){
  const sd=document.getElementById('start-date').value;
  const ed=document.getElementById('end-date').value;
  if(sd)startDate=sd;if(ed)endDate=ed;
  sensiCache={};_doBacktest(params.alpha,params.mcbeta,params.n);refreshAll();
}
function syncDatePicker(prefix){
  const m=document.getElementById(prefix+'-month').value;
  const y=document.getElementById(prefix+'-year').value;
  const val=y+'-'+m;
  document.getElementById(prefix+'-date').value=val;
  if(prefix==='start')startDate=val;else endDate=val;
  sensiCache={};_doBacktest(params.alpha,params.mcbeta,params.n);refreshAll();
}

// ═══════════════════════════════════════
// REGIME CALCULATOR (exact Excel formulas)
// ═══════════════════════════════════════
function computeRegimeCalc(){
  const gdp=parseFloat(document.getElementById('rc-gdp').value);
  const pmi=parseFloat(document.getElementById('rc-pmi').value);
  const unemp=parseFloat(document.getElementById('rc-unemp').value);
  const retail=parseFloat(document.getElementById('rc-retail').value);
  const cpi=parseFloat(document.getElementById('rc-cpi').value);
  const pce=parseFloat(document.getElementById('rc-pce').value);
  if([gdp,pmi,unemp,retail,cpi,pce].some(isNaN)){alert('Fill in all 6 indicators.');return;}
  const h=Math.max(-7,Math.min(7,(gdp*100-1)*3));
  const i=Math.max(-7,Math.min(7,(pmi-50)*0.65));
  const j=Math.max(-7,Math.min(7,(unemp-4.5)*2.8*-1));
  const k=Math.max(-7,Math.min(7,(retail-0.3)*2));
  const l=Math.max(-7,Math.min(7,(cpi-2.5)*2));
  const mn=Math.max(-7,Math.min(7,(pce-2)*2));
  const x=(h*2+i*3+j*2+k*1)/8;
  const y2=(l*3+mn*2)/5;
  const quad=x>=0&&y2<0?'Expansion':x<0&&y2<0?'Deflation':x>=0&&y2>=0?'Reflation':'Stagflation';
  const qc={Expansion:'var(--green)',Deflation:'var(--blue)',Reflation:'var(--amber)',Stagflation:'var(--red)'}[quad];
  document.getElementById('rc-x').textContent=x.toFixed(4);
  document.getElementById('rc-x').style.color=x>=0?'var(--green)':'var(--red)';
  document.getElementById('rc-y').textContent=y2.toFixed(4);
  document.getElementById('rc-y').style.color=y2<0?'var(--green)':'var(--red)';
  document.getElementById('rc-quadrant').textContent=quad;
  document.getElementById('rc-quadrant').style.color=qc;
  document.getElementById('rc-breakdown').innerHTML=`<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 20px;">
    <span style="color:var(--subtle)">GDP norm (H):</span><span>${h.toFixed(4)}</span>
    <span style="color:var(--subtle)">PMI norm (I):</span><span>${i.toFixed(4)}</span>
    <span style="color:var(--subtle)">Unemp norm (J):</span><span>${j.toFixed(4)}</span>
    <span style="color:var(--subtle)">Retail norm (K):</span><span>${k.toFixed(4)}</span>
    <span style="color:var(--subtle)">CPI norm (L):</span><span>${l.toFixed(4)}</span>
    <span style="color:var(--subtle)">PCE norm (M):</span><span>${mn.toFixed(4)}</span>
    <span style="color:var(--subtle);font-weight:600">X=(H*2+I*3+J*2+K*1)/8:</span><span style="font-weight:600;color:${x>=0?'var(--green)':'var(--red)'}">${x.toFixed(4)}</span>
    <span style="color:var(--subtle);font-weight:600">Y=(L*3+M*2)/5:</span><span style="font-weight:600;color:${y2<0?'var(--green)':'var(--red)'}">${y2.toFixed(4)}</span>
  </div>`;
  regimeCalcCoords={rx:parseFloat(x.toFixed(4)),ry:parseFloat(y2.toFixed(4)),quadrant:quad};
  document.getElementById('rc-result').style.display='block';
  document.getElementById('rc-empty').style.display='none';
}
function applyRegimeToPortfolio(){
  if(!regimeCalcCoords){alert('Compute regime first.');return;}
  const qKeys=Object.keys(quarterly).sort();
  quarterly[qKeys[qKeys.length-1]]={...quarterly[qKeys[qKeys.length-1]],...regimeCalcCoords};
  showTab('portfolio');
}

// ═══════════════════════════════════════
// PORTFOLIO TAB
// ═══════════════════════════════════════
function getCurrentRegimeCoords(){
  const qKeys=Object.keys(quarterly).filter(qk=>qk>=startDate&&qk<=endDate).sort();
  if(!qKeys.length)return null;
  return quarterly[qKeys[qKeys.length-1]]||null;
}
function renderPortfolio(){
  const q=getCurrentRegimeCoords();
  if(!q){const tb=document.getElementById('port-holdings-body');if(tb)tb.innerHTML='<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--subtle);">No data in selected window</td></tr>';return;}
  const pill=document.getElementById('port-regime-pill');
  const coord=document.getElementById('port-regime-coord');
  if(pill){pill.textContent=q.quadrant;pill.className=`rpill rpill-${q.quadrant.charAt(0)}`;}
  if(coord)coord.textContent=`(${q.rx.toFixed(4)}, ${q.ry.toFixed(4)})`;
  const lastQk=Object.keys(ALL_QUARTERLY).filter(qk=>qk<=endDate).sort().pop()||endDate;
  const avail=ASSETS.filter(a=>a.first_data&&a.first_data<=lastQk).map(a=>a.asset);
  const holdings=computeWeights(q.rx,q.ry,avail,params.alpha,params.mcbeta,params.n);
  const tbody=document.getElementById('port-holdings-body');
  if(!tbody)return;
  tbody.innerHTML=holdings.map((h,idx)=>{
    const wPct=(h.weight*100).toFixed(1);
    const barW=Math.round(h.weight*100);
    const distCol=h.dist<1.5?'var(--green)':h.dist<3?'var(--amber)':'var(--muted)';
    const a=ASSETS.find(x=>x.asset===h.asset);
    const score=((1/(Math.pow(h.dist,params.alpha)+0.1))*Math.pow(a?.confMult||1,params.mcbeta)).toFixed(2);
    return`<tr style="border-bottom:1px solid var(--border);" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
      <td style="padding:6px 12px;font-family:var(--mono);font-size:10px;color:var(--subtle);">${idx+1}</td>
      <td style="padding:6px 12px;font-size:11px;font-weight:600;color:var(--text);">${h.asset}</td>
      <td style="padding:6px 12px;"><span class="badge badge-${h.type}">${h.type.slice(0,3)}</span></td>
      <td style="padding:6px 12px;text-align:right;font-family:var(--mono);font-size:10px;color:${distCol};">${h.dist.toFixed(2)}</td>
      <td style="padding:6px 12px;text-align:right;font-family:var(--mono);font-size:10px;color:var(--muted);">${score}</td>
      <td style="padding:6px 12px;"><div style="display:flex;align-items:center;gap:8px;">
        <div style="flex:1;height:4px;background:var(--surface3);border-radius:2px;overflow:hidden;">
          <div style="height:100%;width:${barW}%;background:${TC[h.type]};border-radius:2px;"></div>
        </div>
        <span style="font-family:var(--mono);font-size:11px;font-weight:600;color:var(--text);min-width:38px;text-align:right;">${wPct}%</span>
      </div></td>
    </tr>`;
  }).join('');
  const sectorTotals={};
  for(const h of holdings)sectorTotals[h.type]=(sectorTotals[h.type]||0)+h.weight;
  const donutEl=document.getElementById('port-donut');
  if(donutEl){
    const sectors=Object.entries(sectorTotals).sort((a,b)=>b[1]-a[1]);
    Plotly.react('port-donut',[{labels:sectors.map(([t])=>t),values:sectors.map(([,v])=>+(v*100).toFixed(1)),type:'pie',hole:0.55,marker:{colors:sectors.map(([t])=>TC[t]||'#888'),line:{color:'#0C0C0F',width:2}},textfont:{size:9,color:'#F0EFF8'},textinfo:'label+percent',hovertemplate:'%{label}: %{value:.1f}%<extra></extra>'}],{paper_bgcolor:'rgba(0,0,0,0)',plot_bgcolor:'rgba(0,0,0,0)',margin:{l:4,r:4,t:4,b:4},showlegend:false,font:{family:"'DM Mono',monospace",size:9,color:'#8888AA'}},{displayModeBar:false,responsive:true});
  }
  const barsEl=document.getElementById('port-sector-bars');
  if(barsEl)barsEl.innerHTML=Object.entries(sectorTotals).sort((a,b)=>b[1]-a[1]).map(([type,w])=>`<div style="margin-bottom:7px;"><div style="display:flex;justify-content:space-between;margin-bottom:3px;"><span style="font-size:10px;color:${TC[type]};font-weight:600;">${type}</span><span style="font-family:var(--mono);font-size:10px;color:var(--muted);">${(w*100).toFixed(1)}%</span></div><div style="height:4px;background:var(--surface3);border-radius:2px;overflow:hidden;"><div style="height:100%;width:${(w*100).toFixed(1)}%;background:${TC[type]};border-radius:2px;"></div></div></div>`).join('');
  const statsEl=document.getElementById('port-stats-grid');
  if(statsEl){
    const avgDist=holdings.length?(holdings.reduce((s,h)=>s+h.dist,0)/holdings.length).toFixed(2):'—';
    statsEl.innerHTML=[['N held',holdings.length],['Top asset',holdings[0]?.asset||'—'],['Top weight',holdings[0]?(holdings[0].weight*100).toFixed(1)+'%':'—'],['Avg dist',avgDist]].map(([l,v])=>`<div style="background:var(--surface2);border:1px solid var(--border);border-radius:3px;padding:6px 8px;"><div style="font-size:9px;color:var(--subtle);text-transform:uppercase;letter-spacing:.5px;font-family:var(--mono);">${l}</div><div style="font-family:var(--mono);font-size:13px;font-weight:500;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${v}</div></div>`).join('');
  }
}
function exportPortfolioJSON(){
  const q=getCurrentRegimeCoords();if(!q)return;
  const lastQk=Object.keys(ALL_QUARTERLY).filter(qk=>qk<=endDate).sort().pop()||endDate;
  const avail=ASSETS.filter(a=>a.first_data&&a.first_data<=lastQk).map(a=>a.asset);
  const holdings=computeWeights(q.rx,q.ry,avail,params.alpha,params.mcbeta,params.n);
  const data={generated:new Date().toISOString(),regime:q.quadrant,coords:{rx:q.rx,ry:q.ry},params:{...params},window:{start:startDate,end:endDate},holdings:holdings.map(h=>({asset:h.asset,type:h.type,weight:+(h.weight*100).toFixed(2),dist:+h.dist.toFixed(3)}))};
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.download=`marc-portfolio-${q.quadrant.toLowerCase()}-${new Date().toISOString().slice(0,10)}.json`;a.click();
}
function copyPortfolioCSV(){
  const q=getCurrentRegimeCoords();if(!q)return;
  const lastQk=Object.keys(ALL_QUARTERLY).filter(qk=>qk<=endDate).sort().pop()||endDate;
  const avail=ASSETS.filter(a=>a.first_data&&a.first_data<=lastQk).map(a=>a.asset);
  const holdings=computeWeights(q.rx,q.ry,avail,params.alpha,params.mcbeta,params.n);
  const rows=['Asset,Type,Weight %,Distance'];
  holdings.forEach(h=>rows.push(`${h.asset},${h.type},${(h.weight*100).toFixed(2)},${h.dist.toFixed(3)}`));
  navigator.clipboard.writeText(rows.join('\n')).then(()=>{const btn=document.getElementById('csv-btn');if(btn){const o=btn.textContent;btn.textContent='\u2713 Copied';setTimeout(()=>btn.textContent=o,1500);}});
}
function exportForAgent(){
  const q=getCurrentRegimeCoords();if(!q)return;
  const lastQk=Object.keys(ALL_QUARTERLY).filter(qk=>qk<=endDate).sort().pop()||endDate;
  const avail=ASSETS.filter(a=>a.first_data&&a.first_data<=lastQk).map(a=>a.asset);
  const holdings=computeWeights(q.rx,q.ry,avail,params.alpha,params.mcbeta,params.n);
  const today=new Date().toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  const lines=[`MARC SNAPSHOT \u2014 ${today}`,'═══════════════════════════════','REGIME',`Quadrant: ${q.quadrant}`,`Growth score (X): ${q.rx.toFixed(4)} | Inflation score (Y): ${q.ry.toFixed(4)}`,'','PARAMETERS',`Alpha: ${params.alpha} | N: ${Math.round(params.n)} | mcBeta: ${params.mcbeta}`,`Window: ${startDate} \u2192 ${endDate}`,'','MODEL PORTFOLIO (target weights)',...holdings.map(h=>`${h.asset}: ${(h.weight*100).toFixed(1)}%`),'═══════════════════════════════'];
  const text=lines.join('\n');
  const btn=document.getElementById('agent-btn');
  if(navigator.clipboard){navigator.clipboard.writeText(text).then(()=>{if(btn){const o=btn.textContent;btn.textContent='\u2713 Copied!';btn.style.borderColor='var(--amber)';btn.style.color='var(--amber)';setTimeout(()=>{btn.textContent=o;btn.style.borderColor='var(--green)';btn.style.color='var(--green)';},2000);}});}
  else{window.prompt('Copy this snapshot:',text);}
}

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded',function(){
  const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const years=[];for(let y=2010;y<=2026;y++)years.push(y);
  function buildSelects(prefix,defaultVal){
    const [dYear,dMonth]=defaultVal.split('-').map(Number);
    const mSel=document.getElementById(prefix+'-month');
    const ySel=document.getElementById(prefix+'-year');
    mSel.innerHTML=MONTHS.map((m,i)=>`<option value="${String(i+1).padStart(2,'0')}" ${i+1===dMonth?'selected':''}>${m}</option>`).join('');
    ySel.innerHTML=years.map(y=>`<option value="${y}" ${y===dYear?'selected':''}>${y}</option>`).join('');
  }
  buildSelects('start','2010-01');
  buildSelects('end','2026-03');
  document.getElementById('start-date').addEventListener('change',onDateChange);
  document.getElementById('start-date').addEventListener('input',onDateChange);
  document.getElementById('end-date').addEventListener('change',onDateChange);
  document.getElementById('end-date').addEventListener('input',onDateChange);
  initAssetConstraints();initCompSelect();renderCompList();
  _doBacktest(params.alpha,params.mcbeta,params.n);refreshAll();
});
