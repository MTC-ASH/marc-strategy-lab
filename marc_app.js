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
let sectorCaps  = {Equity:1, ETF:1, Crypto:1, Commodity:1};
let assetCaps   = {};   // 0..1
let assetFloors = {};   // 0..1
let comparisons = [];
let quarterly   = JSON.parse(JSON.stringify(ALL_QUARTERLY));
let btResults   = JSON.parse(JSON.stringify(ALL_RESULTS));
btResults._ma   = MONTHLY_ATTR;
let startDate   = '2010-01';
let endDate     = '2025-12';
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
  params[key]=parseFloat(val);
  document.getElementById(`dv-${key}`).textContent = key==='n' ? Math.round(params.n) : params[key].toFixed(2);
}

function addComparison() {
  const s=document.getElementById('comp-select'), asset=s.value; if(!asset) return;
  if(comparisons.find(c=>c.asset===asset)) return;
  comparisons.push({asset, color:CC[comparisons.length%CC.length]});
  s.value=''; renderCompList(); renderCumReturn();
}
function removeComparison(asset) { comparisons=comparisons.filter(c=>c.asset!==asset); renderCompList(); renderCumReturn(); }
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
    const alphas=[0.2,0.5,0.8,1.0,1.5,2.0,3.0,4.0],betas=[0,0.25,0.5,0.75,1.0],ns=[5,8,10,12,15,18,20];
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
  const sortedAssets=Object.entries(totals).filter(([,v])=>Math.abs(v)>0.001).sort((a,b)=>b[1]-a[1]).map(([k])=>k);
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
  document.querySelectorAll('.tab-btn').forEach((t,i)=>t.classList.toggle('active',['main','years','attribution','map','sensitivity'][i]===id));
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
  document.getElementById(`tab-${id}`).classList.add('active');
  if(id==='years')renderYearCards();
  if(id==='attribution')renderAttributionTab();
  if(id==='map')renderMap();
  if(id==='sensitivity')renderSensitivity();
  setTimeout(()=>window.dispatchEvent(new Event('resize')),50);
}

function togglePanel(side){
  const el=document.getElementById(`${side}-panel`);
  el.classList.toggle('collapsed');
  const btn=document.getElementById(`${side==='left'?'l':'r'}panel-btn`);
  const collapsed=el.classList.contains('collapsed');
  btn.style.opacity=collapsed?'.5':'1';
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
  if(showElig)renderEligibility();
}

// ═══════════════════════════════════════
// KEYBOARD
// ═══════════════════════════════════════
document.addEventListener('keydown',e=>{
  if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;
  if(e.key==='1')showTab('main');
  if(e.key==='2')showTab('years');
  if(e.key==='3')showTab('attribution');
  if(e.key==='4')showTab('map');
  if(e.key==='5')showTab('sensitivity');
  if(e.key==='l'||e.key==='L')toggleLog();
  if(e.key==='Escape'){closeSnap();document.querySelectorAll('.cap-popup').forEach(el=>el.remove());}
});

document.getElementById('start-date').addEventListener('change',e=>{
  startDate=e.target.value;
  sensiCache={};
  refreshAll();
});
document.getElementById('end-date').addEventListener('change',e=>{
  endDate=e.target.value;
  sensiCache={};
  refreshAll();
});

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
initAssetConstraints();
initCompSelect();
renderCompList();
_doBacktest(params.alpha,params.mcbeta,params.n);
refreshAll();
