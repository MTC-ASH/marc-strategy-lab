// ═══════════════════════════════════════════════════════════════
// MTC Strategy Suite — Research Lab  (mtc_lab.js)
// Requires: marc_data.js, mtc_core.js
// Provides: auth, fund management, Lab UI wiring, AI Research tab,
//           model library bridge, and the boot sequence
//
// FUNCTION INDEX:
//   doLogin()              — login form handler
//   onLoginSuccess()       — post-auth setup
//   renderFundTabs()       — populate fund selector (legacy topbar)
//   activateFund()         — switch active fund
//   showLabAIPanel()       — AI Research tab renderer
//   labAIAnalyse()         — trigger AI analysis of current backtest
//   labAIStream()          — stream AI response into panel
//   renderModelLibrary()   — model library card (called from mtc_bag.js too)
//   initLab()              — wire up Research Lab tab events
// ═══════════════════════════════════════════════════════════════

// ── Helper: get proxy URL ─────────────────────────────────────────
// mtc_core.js declares PROXY_URL as const — access it directly
function _proxyUrl() {
  try { if (typeof PROXY_URL !== 'undefined') return PROXY_URL; } catch(e) {}
  return 'https://marc-agent.asher-8ca.workers.dev/';
}
function _api() { return _proxyUrl().replace(/\/+$/, ''); }
function _authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': (typeof _marcDB !== 'undefined' && _marcDB.jwt) ? 'Bearer ' + _marcDB.jwt : '',
    'Origin': 'https://mtc-ash.github.io'
  };
}

// ═══════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════
async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-password').value;
  const btn   = document.getElementById('login-btn');
  const errEl = document.getElementById('login-err');
  if (!email || !pass) { showLoginErr('Please enter email and password.'); return; }
  btn.textContent = 'Signing in…'; btn.disabled = true;
  errEl.style.display = 'none';
  try {
    await dbLogin(email, pass);
    // Persist email for next visit
    try { localStorage.setItem('marc_email', email); } catch(e) {}
    await onLoginSuccess();
  } catch(e) {
    showLoginErr(e.message || 'Login failed. Check credentials.');
    btn.textContent = 'Sign In'; btn.disabled = false;
  }
}

function showLoginErr(msg) {
  const el = document.getElementById('login-err');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

async function onLoginSuccess() {
  // Hide login overlay
  const overlay = document.getElementById('marc-login');
  if (overlay) overlay.style.display = 'none';
  try {
    const funds = await dbLoadFunds();
    // Create defaults if none exist
    if (!funds.length) {
      await dbCreateFund('Live Fund', 'live', '#00C97A');
      await dbCreateFund('Experimental', 'experimental', '#FFB020');
    }
    renderFundTabs();
    // Activate previously active fund or first
    let toActivate = null;
    try {
      const saved = JSON.parse(localStorage.getItem('marc_active_fund') || 'null');
      if (saved) toActivate = _marcDB.funds.find(f => f.id === saved.id);
    } catch(e) {}
    if (!toActivate) toActivate = _marcDB.funds[0];
    await activateFund(toActivate);
    // Run initial backtest
    setTimeout(() => { if (typeof runBacktest === 'function') runBacktest(); }, 300);
  } catch(e) {
    console.error('Post-login error:', e);
    showLoginErr('Login succeeded but failed to load data: ' + e.message);
  }
}

// ═══════════════════════════════════════
// FUND MANAGEMENT
// ═══════════════════════════════════════
function renderFundTabs() {
  // Legacy: fund selector in topbar (now used only for Live/Experimental within a mode)
  const container = document.getElementById('fund-selector');
  if (!container || !_marcDB.funds.length) return;
  container.innerHTML = _marcDB.funds.map(fund => {
    const isActive = _marcDB.activeFund && _marcDB.activeFund.id === fund.id;
    const cls = isActive
      ? (fund.type === 'live' ? 'active-live' : 'active-experimental')
      : 'inactive';
    return `<button class="fund-tab ${cls}" onclick="activateFundById('${fund.id}')"
      style="${isActive ? `border-color:${fund.color};color:${fund.color};background:${fund.color}22;` : ''}">
      ${fund.type === 'live' ? '◆' : '◈'} ${fund.name}
    </button>`;
  }).join('');
}

function activateFundById(id) {
  const fund = _marcDB.funds.find(f => f.id === id);
  if (fund) activateFund(fund);
}

async function activateFund(fund) {
  if (!fund) return;
  await dbSetActiveFund(fund);
  renderFundTabs();
  // Experimental mode banner
  const banner = document.getElementById('exp-banner');
  if (banner) banner.classList.toggle('visible', fund.type === 'experimental');
  // Reload chat history
  if (typeof navChatHistory !== 'undefined') {
    navChatHistory = (_marcDB.cache.messages || []).map(m => ({role: m.role, content: m.content}));
  }
  // Refresh nav if open
  if (typeof renderNavDashboard === 'function') {
    renderNavRegimePanel();
    renderNavDashboard();
  }
}

// ═══════════════════════════════════════
// AI RESEARCH TAB
// New in v2 — streaming AI analysis of the current backtest
// ═══════════════════════════════════════
let _labAIHistory = [];

function showLabAIPanel() {
  // Called when user clicks the AI Research tab button
  // The tab is dynamically added to the Research Lab tab bar
  renderLabAIPanel();
}

function renderLabAIPanel() {
  const center = document.getElementById('center-panel');
  if (!center) return;

  // Check if AI panel already exists
  let pane = document.getElementById('tab-ai-research');
  if (!pane) {
    // Add tab button
    const tabs = document.querySelector('#mode-lab .tabs');
    if (tabs) {
      const btn = document.createElement('div');
      btn.className = 'tab-btn';
      btn.id = 'tab-btn-ai-research';
      btn.textContent = '⬡ AI Research';
      btn.style.color = 'var(--green)';
      btn.onclick = () => {
        showTab('ai-research');
        renderLabAIPanel();
      };
      tabs.appendChild(btn);
    }
    // Create pane
    pane = document.createElement('div');
    pane.className = 'tab-pane';
    pane.id = 'tab-ai-research';
    pane.style.cssText = 'display:none;flex-direction:column;height:100%;overflow:hidden;';
    center.appendChild(pane);
  }

  // Get current backtest context
  const {filtered} = filterByDates(btResults, null);
  const stats = filtered.length ? calcStats(filtered) : {};
  const lastQ = Object.keys(quarterly).sort().pop();
  const q = lastQ ? quarterly[lastQ] : null;
  const topHoldings = (q?.holdings || []).slice(0, 8)
    .map(h => `${h.asset} ${(h.weight*100).toFixed(1)}%`).join(', ');

  const contextSummary = filtered.length ? [
    `Period: ${startDate} → ${endDate}`,
    `Sharpe: ${fx(stats.sharpe)} | CAGR: ${pct(stats.cagr,1)} | Max DD: -${xpct(stats.mdd,1)}`,
    `Sortino: ${fx(stats.sortino)} | Calmar: ${fx(stats.calmar)} | Churn: ${xpct(stats.avgL1,0)}/qtr`,
    `α=${params.alpha} N=${Math.round(params.n)} β=${params.mcbeta}`,
    `Regime: ${q?.quadrant || '—'} | Holdings: ${topHoldings || '—'}`,
  ].join('\n') : 'Run backtest first';

  pane.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--bg);">

      <!-- Context bar -->
      <div style="padding:10px 14px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;">
        <div style="font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px;">Current backtest context</div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--muted);line-height:1.6;white-space:pre;">${contextSummary}</div>
      </div>

      <!-- Quick prompts -->
      <div style="padding:8px 14px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;display:flex;gap:6px;flex-wrap:wrap;">
        <button onclick="labAIQuick('Is this strategy overfit? Analyse the sensitivity to α and N parameters.')" class="nav-quick-btn" style="color:var(--amber);border-color:rgba(255,176,32,0.3);">Overfitting check</button>
        <button onclick="labAIQuick('What do the performance metrics tell us? Which metrics are strong vs weak and why?')" class="nav-quick-btn">Interpret metrics</button>
        <button onclick="labAIQuick('How does this compare to a 60/40 portfolio or simple BTC/SPY exposure? What is the alpha source?')" class="nav-quick-btn">Alpha source</button>
        <button onclick="labAIQuick('What parameter changes would you recommend to improve risk-adjusted returns? Be specific.')" class="nav-quick-btn" style="color:var(--green);border-color:rgba(0,201,122,0.3);">Optimise suggestion</button>
        <button onclick="labAIQuick('What are the key risks in this strategy? What market conditions would break it?')" class="nav-quick-btn">Stress test</button>
        <button onclick="labAIClear()" style="margin-left:auto;font-size:9px;font-family:var(--mono);background:none;border:1px solid var(--border);color:var(--subtle);padding:2px 7px;border-radius:var(--r-sm);cursor:pointer;">✕ Clear</button>
      </div>

      <!-- Chat thread -->
      <div id="lab-ai-thread" style="flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px;">
        <div id="lab-ai-empty" style="text-align:center;padding:40px 20px;color:var(--subtle);font-family:var(--mono);font-size:11px;">
          Ask anything about this backtest<br>
          <span style="font-size:9px;opacity:.6;">Analysis is grounded in your actual results</span>
        </div>
      </div>

      <!-- Input -->
      <div style="padding:10px 14px;border-top:1px solid var(--border);flex-shrink:0;background:var(--surface);">
        <div style="display:flex;gap:6px;align-items:flex-end;">
          <textarea id="lab-ai-input" placeholder="Ask about this backtest, strategy, or request specific analysis…" rows="2"
            style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--text);font-family:var(--mono);font-size:11px;padding:7px 9px;resize:none;outline:none;line-height:1.5;box-sizing:border-box;"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();labAISend();}"></textarea>
          <button onclick="labAISend()" id="lab-ai-send"
            style="padding:7px 14px;background:var(--green);color:#000;border:none;border-radius:var(--r-sm);font-family:var(--sans);font-size:11px;font-weight:700;cursor:pointer;flex-shrink:0;align-self:flex-end;">▶</button>
        </div>
      </div>
    </div>
  `;
}

function labAIQuick(msg) {
  // Refresh panel context first, then send
  renderLabAIPanel();
  setTimeout(() => {
    const input = document.getElementById('lab-ai-input');
    if (input) { input.value = msg; labAISend(); }
  }, 50);
}

async function labAISend() {
  const input  = document.getElementById('lab-ai-input');
  const sendBtn = document.getElementById('lab-ai-send');
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '…'; }
  await labAIDispatch(msg);
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '▶'; }
}

function labAIAddMessage(role, content, isThinking) {
  const thread = document.getElementById('lab-ai-thread');
  const empty  = document.getElementById('lab-ai-empty');
  if (empty) empty.style.display = 'none';
  if (!thread) return null;

  const id  = 'lab-msg-' + Date.now();
  const ts  = new Date().toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
  const div = document.createElement('div');
  div.id        = id;
  div.className = 'nav-chat-msg ' + role + (isThinking ? ' nav-chat-thinking' : '');

  const bubble = document.createElement('div');
  bubble.className = 'nav-chat-bubble';
  if (isThinking) {
    bubble.textContent = '⬡ Analysing…';
  } else if (role === 'user') {
    bubble.textContent = content;
  } else {
    bubble.innerHTML = typeof renderMarkdown === 'function' ? renderMarkdown(content) : content;
  }

  const tsEl = document.createElement('div');
  tsEl.className   = 'nav-chat-ts';
  tsEl.textContent = ts;

  div.appendChild(bubble);
  div.appendChild(tsEl);
  thread.appendChild(div);
  thread.scrollTop = thread.scrollHeight;
  return id;
}

function labAIUpdateMessage(id, content) {
  const msg = document.getElementById(id);
  if (!msg) return;
  msg.classList.remove('nav-chat-thinking');
  const bubble = msg.querySelector('.nav-chat-bubble');
  if (bubble) bubble.innerHTML = typeof renderMarkdown === 'function' ? renderMarkdown(content) : content;
  const thread = document.getElementById('lab-ai-thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
}

async function labAIDispatch(userMsg) {
  labAIAddMessage('user', userMsg);
  const thinkingId = labAIAddMessage('agent', '', true);

  // Build rich backtest context
  const systemPrompt = buildLabAISystem();
  _labAIHistory.push({role: 'user', content: buildLabAIPrompt(userMsg)});

  try {
    const r = await fetch(_api() + '/ai', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Origin': 'https://mtc-ash.github.io'},
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system: systemPrompt,
        messages: _labAIHistory
      })
    });
    const d     = await r.json();
    const reply = (d.content && d.content[0] && d.content[0].text)
      ? d.content[0].text : 'No response received.';

    labAIUpdateMessage(thinkingId, reply);
    _labAIHistory.push({role: 'assistant', content: reply});
    // Keep history to last 16 messages
    if (_labAIHistory.length > 16) _labAIHistory = _labAIHistory.slice(-16);
  } catch(e) {
    labAIUpdateMessage(thinkingId,
      `**Error:** ${e.message}\n\nCheck that the Cloudflare Worker is deployed.`);
  }
}

function buildLabAISystem() {
  return `You are a quantitative research analyst embedded in MTC Strategy Suite — a professional macro regime-based portfolio backtesting tool.

The MARC model: assets are positioned in a 2D macro space (Growth x Inflation). The portfolio allocates to assets closest to the current regime coordinates using proximity-weighted scoring. α controls sharpness of proximity focus. N is the number of assets held. mcBeta blends market-cap weighting.

Four regimes: Expansion (high growth, low inflation), Deflation (low growth, low inflation), Reflation (rising growth and inflation), Stagflation (low growth, high inflation).

Your role: analyse backtest results rigorously. Be direct, specific, and quantitative. Flag overfitting risks when you see them (very high Sharpe >2.5, sensitivity to small param changes, short windows). Reference the actual numbers in context. Format responses with ## headers. Use bullet points for key findings. Keep responses under 500 words unless the user asks for more detail.`;
}

function buildLabAIPrompt(userMsg) {
  // Inject live backtest stats into every prompt
  const {filtered} = filterByDates(btResults, null);
  const stats = filtered.length ? calcStats(filtered) : {};
  const lastQ = Object.keys(quarterly).sort().pop();
  const q     = lastQ ? quarterly[lastQ] : null;
  const topH  = (q?.holdings || []).slice(0, 10).map(h =>
    `${h.asset} ${(h.weight*100).toFixed(1)}% (dist: ${h.dist?.toFixed(2)||'?'})`
  ).join(', ');

  // Regime distribution
  const regC = {};
  for (const r of filtered) regC[r.quadrant] = (regC[r.quadrant]||0) + 1;
  const regMix = Object.entries(regC).map(([reg, cnt]) =>
    `${reg}: ${(cnt/filtered.length*100).toFixed(0)}%`).join(' | ');

  const ctx = `[BACKTEST CONTEXT — ${new Date().toLocaleString()}]
Period: ${startDate} → ${endDate} (${stats.n || 0} months)
Parameters: α=${params.alpha}, N=${Math.round(params.n)}, β=${params.mcbeta}

Performance:
  Total Return: ${pct(stats.totalRet||0, 1)}
  CAGR: ${pct(stats.cagr||0, 1)}
  Sharpe: ${fx(stats.sharpe||0)}
  Sortino: ${fx(stats.sortino||0)}
  Calmar: ${fx(stats.calmar||0)}
  Max Drawdown: -${xpct(stats.mdd||0, 1)}
  Best Month: +${xpct(stats.best||0, 1)}
  Worst Month: ${xpct(stats.worst||0, 1)}
  Avg Churn/Qtr: ${xpct(stats.avgL1||0, 0)}

Current regime: ${q?.quadrant || '—'} (X=${q?.rx?.toFixed(3)||'?'}, Y=${q?.ry?.toFixed(3)||'?'})
Regime mix: ${regMix || '—'}
Current model portfolio: ${topH || '—'}

Sector caps: ${Object.entries(sectorCaps).map(([k,v]) => `${k}:${(v*100).toFixed(0)}%`).join(' ')}

`;

  return ctx + userMsg;
}

function labAIClear() {
  _labAIHistory = [];
  const thread = document.getElementById('lab-ai-thread');
  if (thread) thread.innerHTML = `
    <div id="lab-ai-empty" style="text-align:center;padding:40px 20px;color:var(--subtle);font-family:var(--mono);font-size:11px;">
      Ask anything about this backtest<br>
      <span style="font-size:9px;opacity:.6;">Analysis is grounded in your actual results</span>
    </div>`;
}

// ═══════════════════════════════════════
// MODEL LIBRARY RENDERER
// Used by both Research Lab (save confirmation)
// and mtc_bag.js (Model Library page)
// ═══════════════════════════════════════
function renderModelLibrary() {
  const models = loadModelLibrary();

  // Update save button status if in Research Lab
  const statusEl = document.getElementById('save-model-status');
  if (statusEl && models.length) {
    statusEl.textContent = `${models.length} model${models.length > 1 ? 's' : ''} in library`;
    statusEl.style.color = 'var(--muted)';
  }

  // Render to BAG Fund model library page if it exists
  const grid = document.getElementById('bag-models-grid');
  if (grid) _renderModelLibraryGrid(grid, models);
}

function _renderModelLibraryGrid(grid, models) {
  if (!models.length) {
    grid.innerHTML = `
      <div style="grid-column:span 2;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px;gap:12px;color:var(--subtle);">
        <div style="font-size:32px;opacity:.3;">★</div>
        <div style="font-size:13px;font-weight:600;color:var(--muted);">No saved models yet</div>
        <div style="font-size:11px;font-family:var(--mono);">Go to Research Lab → run a backtest → click ★ Save Model</div>
      </div>`;
    return;
  }

  // Leaderboard card
  const sorted = [...models].sort((a, b) => (b.stats.sharpe || 0) - (a.stats.sharpe || 0));
  const bestSharpe = sorted[0];

  grid.innerHTML = `
    <!-- Leaderboard -->
    <div class="card" style="grid-column:span 2;">
      <div class="card-hdr">
        <span class="card-title">Model Library</span>
        <span class="card-meta">${models.length} saved · sorted by Sharpe</span>
      </div>
      <div class="card-body-flush">
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead>
            <tr style="background:var(--surface2);">
              <th style="padding:8px 14px;text-align:left;font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border);">#</th>
              <th style="padding:8px 14px;text-align:left;font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border);">Name</th>
              <th style="padding:8px 14px;text-align:center;font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border);">Params</th>
              <th style="padding:8px 14px;text-align:right;font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border);">Sharpe</th>
              <th style="padding:8px 14px;text-align:right;font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border);">CAGR</th>
              <th style="padding:8px 14px;text-align:right;font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border);">Max DD</th>
              <th style="padding:8px 14px;text-align:right;font-family:var(--mono);font-size:9px;color:var(--subtle);letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border);">Period</th>
              <th style="padding:8px 14px;border-bottom:1px solid var(--border);"></th>
            </tr>
          </thead>
          <tbody>
            ${sorted.map((m, i) => {
              const isBest = m.id === bestSharpe.id;
              return `<tr style="border-bottom:1px solid var(--border);${isBest?'background:rgba(0,201,122,0.04);':''}" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='${isBest?'rgba(0,201,122,0.04)':''}'"
                onclick="loadModelToLab(${m.id})" style="cursor:pointer;">
                <td style="padding:8px 14px;font-family:var(--mono);font-size:10px;color:var(--subtle);">${i+1}</td>
                <td style="padding:8px 14px;">
                  <div style="font-size:11px;font-weight:600;color:var(--text);">${m.name}</div>
                  <div style="font-size:9px;color:var(--subtle);font-family:var(--mono);">${new Date(m.saved_at).toLocaleDateString('en-AU')}</div>
                </td>
                <td style="padding:8px 14px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--muted);">
                  α${m.params.alpha} N${m.params.n} β${m.params.mcbeta}
                </td>
                <td style="padding:8px 14px;text-align:right;font-family:var(--mono);font-size:13px;font-weight:500;color:${(m.stats.sharpe||0)>=1.5?'var(--green)':(m.stats.sharpe||0)>=1?'var(--amber)':'var(--red)'};">
                  ${(m.stats.sharpe||0).toFixed(2)}
                </td>
                <td style="padding:8px 14px;text-align:right;font-family:var(--mono);font-size:11px;color:${(m.stats.cagr||0)>=0?'var(--green)':'var(--red)'};">
                  ${((m.stats.cagr||0)*100).toFixed(1)}%
                </td>
                <td style="padding:8px 14px;text-align:right;font-family:var(--mono);font-size:11px;color:var(--red);">
                  -${((m.stats.mdd||0)*100).toFixed(1)}%
                </td>
                <td style="padding:8px 14px;text-align:right;font-family:var(--mono);font-size:10px;color:var(--subtle);">
                  ${(m.date_range?.start||'').slice(0,7)} → ${(m.date_range?.end||'').slice(0,7)}
                </td>
                <td style="padding:8px 14px;text-align:right;">
                  <button onclick="event.stopPropagation();loadModelToLab(${m.id})"
                    style="font-size:9px;background:var(--blue-dim);border:1px solid var(--blue);color:var(--blue);padding:3px 8px;border-radius:var(--r-sm);cursor:pointer;margin-right:4px;">Load</button>
                  <button onclick="event.stopPropagation();deleteModel(${m.id})"
                    style="font-size:9px;background:none;border:1px solid var(--border);color:var(--subtle);padding:3px 8px;border-radius:var(--r-sm);cursor:pointer;">✕</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Best model card -->
    <div class="card">
      <div class="card-hdr">
        <span class="card-title">★ Best by Sharpe</span>
        <span class="card-meta" style="color:var(--green);">${bestSharpe.name}</span>
      </div>
      <div class="card-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
          ${[
            ['Sharpe', ((bestSharpe.stats.sharpe||0).toFixed(2)), 'b'],
            ['CAGR',   ((bestSharpe.stats.cagr||0)*100).toFixed(1)+'%', 'g'],
            ['Max DD', '-'+((bestSharpe.stats.mdd||0)*100).toFixed(1)+'%', 'r'],
            ['Sortino',((bestSharpe.stats.sortino||0).toFixed(2)), 'b'],
          ].map(([l,v,c]) => `
            <div class="kpi">
              <div class="kpi-l">${l}</div>
              <div class="kpi-v ${c}">${v}</div>
            </div>`).join('')}
        </div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--muted);line-height:1.8;">
          α = ${bestSharpe.params.alpha} &nbsp;·&nbsp; N = ${bestSharpe.params.n} &nbsp;·&nbsp; β = ${bestSharpe.params.mcbeta}<br>
          ${(bestSharpe.date_range?.start||'').slice(0,7)} → ${(bestSharpe.date_range?.end||'').slice(0,7)}<br>
          ${bestSharpe.stats.n_months || '—'} months · Churn ${((bestSharpe.stats.avgL1||0)*100).toFixed(0)}%/qtr
        </div>
        <button onclick="loadModelToLab(${bestSharpe.id})"
          style="width:100%;margin-top:12px;padding:8px;background:var(--blue-dim);border:1px solid var(--blue);color:var(--blue);border-radius:var(--r-sm);font-size:11px;font-weight:700;cursor:pointer;">
          Load into Research Lab →
        </button>
      </div>
    </div>

    <!-- Instructions card -->
    <div class="card">
      <div class="card-hdr">
        <span class="card-title">How to use</span>
        <span class="card-meta">model library guide</span>
      </div>
      <div class="card-body" style="font-size:11px;color:var(--muted);line-height:1.8;">
        <div style="margin-bottom:10px;"><span style="color:var(--green);font-weight:600;">1. Research Lab</span><br>Tune α, N, β and run backtests until you find a configuration you like.</div>
        <div style="margin-bottom:10px;"><span style="color:var(--amber);font-weight:600;">2. Save Model</span><br>Click ★ Save Model in the left panel. Stores params, stats, and monthly return series.</div>
        <div style="margin-bottom:10px;"><span style="color:var(--blue);font-weight:600;">3. Compare</span><br>Load any saved model — it sets parameters back in Research Lab so you can re-run charts.</div>
        <div><span style="color:var(--purple);font-weight:600;">4. Deploy</span><br>Coming soon: overlay saved model returns against live BAG Fund performance on the Performance page.</div>
      </div>
    </div>
  `;
}

// Load a saved model back into Research Lab params
function loadModelToLab(modelId) {
  const models = loadModelLibrary();
  const m = models.find(x => x.id === modelId);
  if (!m) return;

  // Set params
  params.alpha  = m.params.alpha;
  params.mcbeta = m.params.mcbeta;
  params.n      = m.params.n;

  // Update sliders
  ['alpha','mcbeta','n'].forEach(k => {
    const sl = document.getElementById(`sl-${k}`);
    const dv = document.getElementById(`dv-${k}`);
    if (sl) sl.value = params[k];
    if (dv) dv.textContent = k === 'n' ? Math.round(params.n) : params[k].toFixed(2);
  });

  // Set date range if present
  if (m.date_range?.start) {
    startDate = m.date_range.start;
    const [sy, sm] = startDate.split('-');
    const smEl = document.getElementById('start-month');
    const syEl = document.getElementById('start-year');
    if (smEl) smEl.value = sm;
    if (syEl) syEl.value = sy;
    const sdEl = document.getElementById('start-date');
    if (sdEl) sdEl.value = startDate;
  }
  if (m.date_range?.end) {
    endDate = m.date_range.end;
    const [ey, em] = endDate.split('-');
    const emEl = document.getElementById('end-month');
    const eyEl = document.getElementById('end-year');
    if (emEl) emEl.value = em;
    if (eyEl) eyEl.value = ey;
    const edEl = document.getElementById('end-date');
    if (edEl) edEl.value = endDate;
  }

  // Switch to Research Lab and run
  if (typeof switchMode === 'function') switchMode('lab');
  if (typeof runBacktest === 'function') {
    const btn = document.getElementById('run-btn');
    if (btn) btn.click();
  }

  if (typeof addAlert === 'function') {
    addAlert('info', 'Model loaded', m.name + ' → Research Lab');
  }
}

function deleteModel(modelId) {
  if (!confirm('Delete this model from the library?')) return;
  try {
    const models = JSON.parse(localStorage.getItem('mtc_model_library') || '[]');
    const updated = models.filter(m => m.id !== modelId);
    localStorage.setItem('mtc_model_library', JSON.stringify(updated));
  } catch(e) {}
  renderModelLibrary();
}

// ═══════════════════════════════════════
// RESEARCH LAB INIT
// Wire up AI Research tab and model library link
// ═══════════════════════════════════════
function initLab() {
  // Add AI Research tab button to the Lab tab bar
  const tabs = document.querySelector('#mode-lab .tabs');
  if (tabs && !document.getElementById('tab-btn-ai-research')) {
    const btn = document.createElement('div');
    btn.className = 'tab-btn';
    btn.id = 'tab-btn-ai-research';
    btn.textContent = '⬡ AI Research';
    btn.style.color = 'var(--green)';
    btn.onclick = () => {
      // Activate this tab
      document.querySelectorAll('#mode-lab .tab-btn').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('#mode-lab .tab-pane').forEach(p => p.classList.remove('active'));
      renderLabAIPanel();
      const pane = document.getElementById('tab-ai-research');
      if (pane) pane.classList.add('active');
    };
    tabs.appendChild(btn);
  }

  // Render model library count in save button area
  const models = loadModelLibrary();
  const statusEl = document.getElementById('save-model-status');
  if (statusEl && models.length) {
    statusEl.textContent = `${models.length} model${models.length > 1 ? 's' : ''} saved`;
    statusEl.style.color = 'var(--muted)';
  }
}

// ═══════════════════════════════════════
// BOOT SEQUENCE
// Runs on DOMContentLoaded
// Tries to restore session, then hands off to mtc_bag.js (dbInit)
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', async function() {
  // mtc_core.js DOMContentLoaded runs first (declared earlier in file),
  // initialises sliders and runs initial backtest.
  // This handler sets up auth and Lab-specific features.

  try {
    const authenticated = await dbInit();
    if (authenticated) {
      await onLoginSuccess();
    } else {
      // Show login — it's visible by default
      // Pre-fill email if saved
      try {
        const savedEmail = localStorage.getItem('marc_email');
        if (savedEmail) {
          const ef = document.getElementById('login-email');
          if (ef) ef.value = savedEmail;
        }
      } catch(e) {}
    }
  } catch(e) {
    console.warn('Boot error:', e);
    // Login overlay stays visible — user can log in manually
  }

  // Always init Lab features regardless of auth state
  initLab();
  renderModelLibrary();
});
