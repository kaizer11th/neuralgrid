/**
 * NeuralGrid — app.js
 * Connects exclusively to the FastAPI backend via REST + WebSocket.
 * No offline/demo fallback — requires a running backend.
 *
 * BACKEND_URL is set in index.html:
 *   "" means same origin (local dev or Render serving both)
 *   "https://your-app.onrender.com" for GitHub Pages pointing at Render
 */

const BASE = (typeof BACKEND_URL !== 'undefined' && BACKEND_URL)
  ? BACKEND_URL.replace(/\/$/, '')
  : window.location.origin;

const API = BASE + '/api';
const WS  = BASE.replace(/^http/, 'ws') + '/ws';

// ── State (read-only mirror of backend) ───────────────────────────────────
let S = { nodes:[], clients:[], jobs:[], stats:{}, tick:0, running:false,
          util_history:[], throughput_history:[], bw_history:[], recent_events:[] };
let gpuData   = null;
let workloads = [];
let ws        = null;

// ── WebSocket ──────────────────────────────────────────────────────────────
function wsConnect() {
  ws = new WebSocket(WS);

  ws.onopen = () => {
    setWsStatus(true);
    pushTicker('● WEBSOCKET CONNECTED — LIVE DATA STREAM ACTIVE', 'hi');
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'snapshot') applyState(msg.data);
  };

  ws.onclose = () => {
    setWsStatus(false);
    // Reconnect after 3 s
    setTimeout(wsConnect, 3000);
  };

  ws.onerror = () => ws.close();

  // Keepalive ping every 20 s
  setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 20000);
}

function setWsStatus(online) {
  const dot   = document.getElementById('ws-dot');
  const label = document.getElementById('ws-label');
  if (online) {
    dot.style.background   = 'var(--accent)';
    dot.style.boxShadow    = '0 0 8px var(--accent)';
    label.textContent      = 'Live';
  } else {
    dot.style.background   = 'var(--danger)';
    dot.style.boxShadow    = '0 0 8px var(--danger)';
    label.textContent      = 'Reconnecting…';
  }
}

// ── REST helper ────────────────────────────────────────────────────────────
async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('API error', res.status, err);
    return null;
  }
  return res.json();
}

// After any mutation the WebSocket will broadcast the updated state.
// For immediate feedback on step/control we also apply the returned snapshot.
async function ctrl(action, value) {
  const snap = await call('POST', '/sim/control', { action, value });
  if (snap) applyState(snap);
}

// ── Apply state from backend ───────────────────────────────────────────────
function applyState(data) {
  S = data;
  renderAll();
}

// ── Render everything ──────────────────────────────────────────────────────
function renderAll() {
  updateHeader();
  renderNodeList();
  renderJobQueue();
  renderMetrics();
  renderCharts();
  renderLog();
  updateGraph();
  refreshClientSelect();
  document.getElementById('tick-val').textContent = S.tick;
  // Sync auto-btn label
  const btn = document.getElementById('auto-btn');
  if (S.running) { btn.textContent = '⏸ Pause'; btn.className = 'btn btn-danger'; }
  else           { btn.textContent = '⏩ Start'; btn.className = 'btn btn-warn'; }
}

// ── Header stats ───────────────────────────────────────────────────────────
function updateHeader() {
  const st = S.stats;
  document.getElementById('h-nodes').textContent = `${st.total_nodes ?? 0} Nodes`;
  document.getElementById('h-jobs').textContent  = `${st.running_jobs ?? 0} Running`;
  document.getElementById('h-tflops').textContent= `${st.utilized_tflops ?? 0}/${st.total_tflops ?? 0}T`;
  document.getElementById('h-earn').textContent  = `$${(st.total_earnings ?? 0).toFixed(4)}`;
}

// ── Node list (sidebar) ────────────────────────────────────────────────────
function renderNodeList() {
  const el  = document.getElementById('node-list');
  const tot = (S.nodes?.length ?? 0) + (S.clients?.length ?? 0);
  document.getElementById('node-count').textContent = `${tot} total`;

  let html = '';
  (S.nodes ?? []).forEach(n => {
    const c = n.status === 'idle' ? 'var(--accent)' : n.status === 'busy' ? 'var(--accent3)' : 'var(--muted)';
    html += `<div class="node-item">
      <div class="nd" style="background:${c};box-shadow:0 0 6px ${c}"></div>
      <div class="ni">
        <div class="ni-name">${n.name} <span style="color:#4ade80;font-size:10px">$${n.earnings.toFixed(3)}</span></div>
        <div class="ni-meta">${n.gpu_model.replace('NVIDIA ','').replace('AMD ','')} · ${n.vram}GB · ${n.location}</div>
      </div>
      <span class="nbadge s-${n.status}">${n.status}</span>
      <button class="del-btn" onclick="delNode('${n.id}')">✕</button>
    </div>`;
  });
  (S.clients ?? []).forEach(c => {
    html += `<div class="node-item client-row">
      <div class="nd" style="background:var(--accent2);box-shadow:0 0 6px var(--accent2)"></div>
      <div class="ni">
        <div class="ni-name">${c.name}</div>
        <div class="ni-meta">${c.workload_type} · ${c.vram_req}GB · ${c.priority}</div>
      </div>
      <span class="nbadge s-${c.status}">${c.status}</span>
      <button class="del-btn" onclick="delClient('${c.id}')">✕</button>
    </div>`;
  });

  el.innerHTML = html || '<div style="color:var(--muted);font-size:11px;text-align:center;padding:20px">No nodes yet. Add providers above.</div>';
}

// ── Job queue ──────────────────────────────────────────────────────────────
const PICO = { critical:'🔴', high:'🟡', normal:'🟢', low:'⚪' };

function renderJobQueue() {
  const st = S.stats;
  document.getElementById('s-run').textContent  = st.running_jobs  ?? 0;
  document.getElementById('s-que').textContent  = st.queued_jobs   ?? 0;
  document.getElementById('s-done').textContent = st.completed     ?? 0;
  document.getElementById('s-earn').textContent = '$' + (st.total_earnings ?? 0).toFixed(4);

  const el   = document.getElementById('job-queue');
  const jobs = [...(S.jobs ?? [])].reverse();
  if (!jobs.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:11px;text-align:center;padding:30px">No jobs yet.</div>';
    return;
  }
  el.innerHTML = jobs.map(j => {
    const node = (S.nodes ?? []).find(n => n.id === j.assigned_node);
    const sBadge = j.status === 'completed' ? 's-idle' : j.status === 'running' ? 's-busy'
                 : j.status === 'queued'    ? 's-waiting' : 's-offline';
    return `<div class="job-card ${j.status}">
      <div class="jt">
        <div>
          <div class="jname">${PICO[j.priority]||''} ${j.name}</div>
          <div class="jid">${j.id} · ${j.job_type}</div>
        </div>
        <span class="nbadge ${sBadge}">${j.status}</span>
      </div>
      <div class="jmeta">
        <span>⚡ ${j.tflops_req}T</span>
        <span>💾 ${j.vram_req}GB</span>
        <span>🖥 ${node ? node.name : '—'}</span>
        <span>⏱ ${j.duration_ticks}t</span>
        ${j.estimated_cost ? `<span style="color:#4ade80">💲${j.estimated_cost}</span>` : ''}
        <span>📊 ${j.progress}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill ${j.status}" style="width:${j.progress}%"></div>
      </div>
    </div>`;
  }).join('');
}

// ── Analytics metrics ──────────────────────────────────────────────────────
function renderMetrics() {
  const st = S.stats;
  document.getElementById('m-nodes').textContent    = st.total_nodes  ?? 0;
  document.getElementById('m-nodes-sub').textContent= `${st.idle_nodes??0} idle · ${st.busy_nodes??0} busy`;
  document.getElementById('m-tflops').textContent   = st.total_tflops ?? 0;
  document.getElementById('m-util-sub').textContent = `${st.util_pct??0}% utilized`;
  document.getElementById('m-done').textContent     = st.completed    ?? 0;
  const total = (S.jobs??[]).length;
  const rate  = total ? Math.round((st.completed??0)/total*100) : 0;
  document.getElementById('m-done-sub').textContent = `${rate}% success rate`;
  document.getElementById('m-earn').textContent     = '$' + (st.total_earnings??0).toFixed(4);
}

// ── Event log ──────────────────────────────────────────────────────────────
function renderLog() {
  const el = document.getElementById('log-out');
  if (!el) return;
  const events = S.recent_events ?? [];
  el.innerHTML = events.length
    ? events.map(e =>
        `<div class="log-line">
          <span class="log-t">[${e.time}]</span>
          <span class="log-m ${e.level}">${e.msg}</span>
        </div>`).join('')
    : '<div style="color:var(--muted)">No events yet.</div>';
}

// ── Charts ─────────────────────────────────────────────────────────────────
function renderCharts() {
  drawLine('c-util', S.util_history??[], '#00f5c4', 0, 100);
  drawLine('c-thru', S.throughput_history??[], '#7c3aed', 0);
  drawBars('c-vram');
  drawLine('c-bw',   S.bw_history??[], '#f59e0b', 0);
}

function drawLine(id, data, color, minY=0, maxY=null) {
  const cv = document.getElementById(id);
  if (!cv) return;
  const W = cv.offsetWidth || 400, H = 180;
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='rgba(0,0,0,.2)'; ctx.fillRect(0,0,W,H);
  // Grid lines
  ctx.strokeStyle='rgba(255,255,255,.04)'; ctx.lineWidth=1;
  for(let i=0;i<5;i++){const y=(H/4)*i;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
  if(data.length<2) return;
  const dMax = maxY ?? Math.max(...data,1), dMin=minY;
  const xS=W/(data.length-1), yS=(H-20)/(dMax-dMin);
  // Gradient fill
  const g=ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0,color+'44'); g.addColorStop(1,color+'00');
  ctx.beginPath();
  data.forEach((v,i)=>{const x=i*xS,y=H-10-(v-dMin)*yS;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
  ctx.lineTo((data.length-1)*xS,H); ctx.lineTo(0,H); ctx.closePath();
  ctx.fillStyle=g; ctx.fill();
  // Line
  ctx.beginPath(); ctx.strokeStyle=color; ctx.lineWidth=2;
  ctx.shadowBlur=8; ctx.shadowColor=color;
  data.forEach((v,i)=>{const x=i*xS,y=H-10-(v-dMin)*yS;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
  ctx.stroke(); ctx.shadowBlur=0;
  // Last value dot + label
  const lx=(data.length-1)*xS, ly=H-10-(data[data.length-1]-dMin)*yS;
  ctx.beginPath(); ctx.arc(lx,ly,4,0,Math.PI*2); ctx.fillStyle=color; ctx.fill();
  ctx.fillStyle='rgba(100,116,139,.9)'; ctx.font='10px Space Mono,monospace';
  ctx.fillText(String(data[data.length-1]), Math.min(lx+6,W-32), ly+4);
}

function drawBars(id) {
  const cv = document.getElementById(id);
  if (!cv) return;
  const W=cv.offsetWidth||400, H=180;
  cv.width=W; cv.height=H;
  const ctx=cv.getContext('2d');
  ctx.clearRect(0,0,W,H); ctx.fillStyle='rgba(0,0,0,.2)'; ctx.fillRect(0,0,W,H);
  const nodes=(S.nodes??[]).slice(0,8);
  if(!nodes.length){
    ctx.fillStyle='rgba(100,116,139,.5)'; ctx.font='11px Space Mono,monospace';
    ctx.textAlign='center'; ctx.fillText('Add provider nodes to see chart',W/2,H/2); return;
  }
  const maxV=Math.max(...nodes.map(n=>n.vram),1);
  nodes.forEach((n,i)=>{
    const slot=(W-40)/nodes.length;
    const bw=Math.min(48,slot-8);
    const x=20+i*slot;
    const bh=(n.vram/maxV)*(H-50);
    const y=H-30-bh;
    const color=n.status==='busy'?'#f59e0b':n.status==='offline'?'#64748b':'#00f5c4';
    const g=ctx.createLinearGradient(0,y,0,H-30);
    g.addColorStop(0,color+'cc'); g.addColorStop(1,color+'33');
    ctx.fillStyle=g;
    ctx.beginPath();
    if(ctx.roundRect) ctx.roundRect(x,y,bw,bh,3); else ctx.rect(x,y,bw,bh);
    ctx.fill();
    ctx.fillStyle=color; ctx.font='9px Space Mono,monospace'; ctx.textAlign='center';
    ctx.fillText(n.vram+'G',x+bw/2,y-4);
    ctx.fillStyle='rgba(100,116,139,.8)';
    ctx.fillText(n.name.slice(0,6),x+bw/2,H-14);
  });
  ctx.textAlign='left';
}

// ── D3 Network Graph ───────────────────────────────────────────────────────
let svg, sim_force, linkSel, nodeSel;
const SVG_H = 520;

function svgW() {
  const el = document.getElementById('network-svg');
  if (!el) return 700;
  const w = el.getBoundingClientRect().width;
  return w > 50 ? w : el.parentElement?.getBoundingClientRect().width || 700;
}

function initGraph() {
  const el = document.getElementById('network-svg');
  if (!el) return;
  el.innerHTML = '';
  const W = svgW();
  svg = d3.select('#network-svg')
    .attr('width', '100%')
    .attr('height', SVG_H)
    .attr('viewBox', `0 0 ${W} ${SVG_H}`)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  const defs = svg.append('defs');
  [['green','#00f5c4'],['purple','#7c3aed'],['amber','#f59e0b']].forEach(([n,c])=>{
    const f=defs.append('filter').attr('id',`gf-${n}`);
    f.append('feGaussianBlur').attr('stdDeviation','3').attr('result','blur');
    const m=f.append('feMerge');
    m.append('feMergeNode').attr('in','blur');
    m.append('feMergeNode').attr('in','SourceGraphic');
  });

  svg.append('g').attr('class','links-g');
  svg.append('g').attr('class','nodes-g');

  sim_force = d3.forceSimulation()
    .force('link', d3.forceLink().id(d=>d.id).distance(130).strength(0.6))
    .force('charge', d3.forceManyBody().strength(-280))
    .force('center', d3.forceCenter(svgW()/2, SVG_H/2))
    .force('collision', d3.forceCollide(42))
    .on('tick', gTicked);
}

function graphData() {
  const hub={id:'hub',type:'hub',label:'HUB',sub:'Coordinator'};
  const nodes=[
    hub,
    ...(S.nodes??[]).map(n=>({
      id:n.id, type:'provider',
      label: n.name.length>10?n.name.slice(0,10):n.name,
      sub: n.gpu_model.replace('NVIDIA ','').replace('AMD ','').slice(0,14),
      data:n
    })),
    ...(S.clients??[]).map(c=>({
      id:c.id, type:'client',
      label: c.name.length>10?c.name.slice(0,10):c.name,
      sub: c.workload_type,
      data:c
    }))
  ];
  const links=[];
  (S.nodes??[]).forEach(n=>links.push({source:'hub',target:n.id,active:n.status==='busy'}));
  (S.clients??[]).forEach(c=>{
    links.push({source:'hub',target:c.id,active:c.status==='active',isC:true});
    if(c.assigned_node) links.push({source:c.id,target:c.assigned_node,active:true,isC:true});
  });
  return {nodes,links};
}

function updateGraph() {
  if (!svg) return;
  const {nodes,links} = graphData();

  // Preserve positions
  const pos={};
  (sim_force.nodes()??[]).forEach(n=>{pos[n.id]={x:n.x,y:n.y,vx:n.vx,vy:n.vy};});
  nodes.forEach(n=>{
    if(pos[n.id]) Object.assign(n,pos[n.id]);
    if(n.id==='hub'){n.fx=svgW()/2;n.fy=SVG_H/2;}
  });

  // Links
  linkSel = svg.select('.links-g').selectAll('line')
    .data(links, d=>`${d.source?.id||d.source}-${d.target?.id||d.target}`);
  linkSel.exit().remove();
  linkSel = linkSel.enter().append('line').merge(linkSel)
    .attr('class', d=>`link${d.active?' active-job':''}${d.isC?' client-link':''}`);

  // Nodes
  nodeSel = svg.select('.nodes-g').selectAll('g.ng').data(nodes, d=>d.id);
  nodeSel.exit().remove();
  const enter = nodeSel.enter().append('g').attr('class',d=>`ng node-${d.type}`)
    .call(d3.drag()
      .on('start',(e,d)=>{if(!e.active)sim_force.alphaTarget(.3).restart();d.fx=d.x;d.fy=d.y;})
      .on('drag', (e,d)=>{d.fx=e.x;d.fy=e.y;})
      .on('end',  (e,d)=>{if(!e.active)sim_force.alphaTarget(0);if(d.id!=='hub'){d.fx=null;d.fy=null;}}))
    .on('mouseover',showTip).on('mousemove',moveTip).on('mouseout',hideTip);

  enter.append('circle')
    .attr('r', d=>d.type==='hub'?28:d.type==='provider'?22:18)
    .attr('filter', d=>d.type==='hub'?'url(#gf-amber)':d.type==='provider'?'url(#gf-green)':'url(#gf-purple)');
  enter.append('text').attr('class','node-label').attr('dy','4');
  enter.append('text').attr('class','node-sublabel').attr('dy','18');

  nodeSel = enter.merge(nodeSel);
  nodeSel.select('.node-label').text(d=>d.label);
  nodeSel.select('.node-sublabel').text(d=>d.type!=='hub'?d.sub:'COORDINATOR');
  nodeSel.select('circle').attr('stroke', d=>{
    if(d.type==='provider'&&d.data)
      return d.data.status==='busy'?'var(--accent3)':d.data.status==='offline'?'var(--muted)':'var(--accent)';
    return d.type==='client'?'var(--accent2)':'var(--accent3)';
  });

  sim_force.nodes(nodes);
  sim_force.force('link').links(links);
  sim_force.alpha(.3).restart();
}

function gTicked() {
  if (!linkSel||!nodeSel) return;
  linkSel
    .attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
    .attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
  nodeSel.attr('transform',d=>`translate(${d.x},${d.y})`);
}

// ── Tooltip ────────────────────────────────────────────────────────────────
function showTip(event, d) {
  const tt=document.getElementById('tooltip');
  document.getElementById('tt-title').textContent=d.label||'Hub';
  const b=document.getElementById('tt-body');
  if(d.type==='hub'){
    b.innerHTML=r('Nodes',S.nodes?.length??0)+r('Clients',S.clients?.length??0)+r('Tick',`#${S.tick}`);
  } else if(d.type==='provider'&&d.data){
    const n=d.data;
    b.innerHTML=r('GPU',n.gpu_model)+r('VRAM',n.vram+'GB')+r('TFLOPS',n.tflops)
      +r('Status',n.status)+r('Location',n.location)
      +r('Earnings','$'+n.earnings.toFixed(4))
      +r('Vast.ai/hr','$'+n.vastai_rate);
  } else if(d.type==='client'&&d.data){
    const c=d.data;
    b.innerHTML=r('Workload',c.workload_type)+r('VRAM req',c.vram_req+'GB')
      +r('Priority',c.priority)+r('Status',c.status)+r('Jobs submitted',c.jobs_submitted);
  }
  tt.classList.remove('hidden');
  moveTip(event);
}
function r(k,v){return `<div class="tt-row"><span>${k}</span><span>${v}</span></div>`;}
function moveTip(event){
  const tt=document.getElementById('tooltip');
  let x=event.clientX+14,y=event.clientY-10;
  if(x+200>window.innerWidth) x=event.clientX-210;
  tt.style.left=x+'px'; tt.style.top=y+'px';
}
function hideTip(){document.getElementById('tooltip').classList.add('hidden');}

// ── Ticker ─────────────────────────────────────────────────────────────────
function pushTicker(msg, cls='') {
  const el=document.getElementById('ticker-text');
  if(!el) return;
  const sp=document.createElement('span');
  if(cls) sp.className=cls;
  sp.textContent='● '+msg;
  el.prepend(sp);
  while(el.children.length>16) el.lastElementChild.remove();
}

// ── Tab switching ──────────────────────────────────────────────────────────
function switchTab(btn) {
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  const name = btn.dataset.tab;
  document.getElementById('view-'+name).classList.add('active');
  btn.classList.add('active');
  if(name==='analytics') setTimeout(renderCharts, 40);
}

// ── GPU catalog data ───────────────────────────────────────────────────────
async function loadGpuData() {
  const data = await call('GET', '/gpus');
  if (!data) { console.error('Could not load GPU catalog from backend'); return; }
  gpuData   = data;
  workloads = data.workloads || [];

  // Populate GPU model select
  const sel = document.getElementById('p-gpu');
  sel.innerHTML = data.gpus.map(g=>`<option value="${g.model}">${g.model}</option>`).join('');
  previewGpu(data.gpus[0]?.model);

  // Populate workload selects
  const wlHtml = workloads.map(w=>`<option value="${w.type}">${w.icon||''} ${w.name}</option>`).join('');
  document.getElementById('c-wl').innerHTML = wlHtml;

  // Populate preset select
  const preHtml = workloads.map(w=>`<option value="${w.name}">${w.icon||''} ${w.name}</option>`).join('');
  document.getElementById('j-preset').innerHTML = '<option value="">— Custom —</option>'+preHtml;

  // Render GPU table
  renderGpuTable(data.gpus);
}

function previewGpu(model) {
  if(!gpuData) return;
  const g = gpuData.gpus.find(x=>x.model===model);
  if(!g) return;
  document.getElementById('gpu-preview').innerHTML = `
    <div class="gp-grid">
      <span class="gp-k">VRAM</span><span class="gp-v" style="color:var(--accent)">${g.vram_gb}GB ${g.vram_type}</span>
      <span class="gp-k">FP32 TFLOPS</span><span class="gp-v" style="color:var(--accent)">${g.tflops_fp32}</span>
      <span class="gp-k">FP16 TFLOPS</span><span class="gp-v">${g.tflops_fp16}</span>
      <span class="gp-k">TDP</span><span class="gp-v">${g.tdp_watts}W</span>
      <span class="gp-k">Market Price</span><span class="gp-v" style="color:var(--accent3)">$${g.market_price_usd.toLocaleString()}</span>
      <span class="gp-k">Salad.com/hr</span><span class="gp-v" style="color:#4ade80">$${g.salad_rate_per_hour}</span>
      <span class="gp-k">Vast.ai/hr</span><span class="gp-v" style="color:#4ade80">$${g.vastai_rate_per_hour}</span>
      <span class="gp-k">Tier</span><span class="gp-v"><span class="tier ${g.tier}">${g.tier}</span></span>
    </div>`;
}

function renderGpuTable(gpus) {
  document.getElementById('gpu-tbody').innerHTML = gpus.map(g=>`
    <tr>
      <td><strong>${g.model}</strong><br>
        <span style="color:var(--muted);font-size:10px">${g.architecture} · ${g.release_year}</span></td>
      <td><span class="tier ${g.tier}">${g.tier}</span></td>
      <td style="color:var(--accent)">${g.vram_gb}GB<br>
        <span style="color:var(--muted);font-size:10px">${g.vram_type}</span></td>
      <td style="color:var(--accent)">${g.tflops_fp32}</td>
      <td>${g.tflops_fp16}</td>
      <td>${g.memory_bandwidth_gbps}</td>
      <td style="color:var(--accent3)">${g.tdp_watts}W</td>
      <td>$${g.market_price_usd.toLocaleString()}</td>
      <td style="color:#4ade80">$${g.vastai_rate_per_hour}/hr</td>
      <td style="color:#4ade80">$${g.salad_rate_per_hour}/hr</td>
    </tr>`).join('');
}

function applyPreset(name) {
  const wl = workloads.find(w=>w.name===name);
  if(!wl) return;
  document.getElementById('j-vram').value   = wl.min_vram_gb;
  document.getElementById('j-tflops').value = wl.tflops_required;
  document.getElementById('j-dur').value    = wl.avg_duration_ticks;
  document.getElementById('j-name').value   = wl.name + ' #' + Math.floor(Math.random()*99+1);
}

function refreshClientSelect() {
  const sel = document.getElementById('j-client');
  sel.innerHTML = '<option value="">— None —</option>'
    + (S.clients??[]).map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
}

// ── Action buttons ─────────────────────────────────────────────────────────
let _pCount=1, _cCount=1;

async function addNode() {
  const model = document.getElementById('p-gpu').value;
  if (!model) return;
  const name = document.getElementById('p-name').value.trim()
    || `GPU_NODE_${String(_pCount).padStart(3,'0')}`;
  await call('POST', '/nodes', {
    name,
    gpu_model: model,
    bandwidth_gbps: parseFloat(document.getElementById('p-bw').value) || 10,
    location: document.getElementById('p-loc').value,
  });
  document.getElementById('p-name').value='';
  _pCount++;
}

async function addClient() {
  const name = document.getElementById('c-name').value.trim()
    || `CLIENT_${String(_cCount).padStart(3,'0')}`;
  await call('POST', '/clients', {
    name,
    workload_type: document.getElementById('c-wl').value,
    vram_req: parseInt(document.getElementById('c-vram').value)||12,
    priority: document.getElementById('c-prio').value,
  });
  document.getElementById('c-name').value='';
  _cCount++;
}

async function submitJob() {
  const name = document.getElementById('j-name').value.trim()
    || `JOB_${Date.now().toString(36).toUpperCase()}`;
  await call('POST', '/jobs', {
    name,
    job_type: document.getElementById('j-preset').value || 'Custom',
    vram_req:       parseInt(document.getElementById('j-vram').value)   || 8,
    tflops_req:     parseInt(document.getElementById('j-tflops').value) || 20,
    duration_ticks: parseInt(document.getElementById('j-dur').value)    || 5,
    priority:       document.getElementById('j-prio').value,
    client_id:      document.getElementById('j-client').value || null,
  });
  document.getElementById('j-name').value='';
}

async function submitRandom() {
  await call('POST', '/jobs/random', {});
}

async function clearDone() {
  await call('DELETE', '/jobs/completed');
}

async function delNode(id)   { await call('DELETE', '/nodes/'+id); }
async function delClient(id) { await call('DELETE', '/clients/'+id); }

function ctrlStep()   { ctrl('step'); }
function ctrlToggle() { ctrl(S.running ? 'stop' : 'start'); }
function ctrlSpeed(v) { ctrl('speed', parseFloat(v)); }

function ctrlReset() {
  if (!confirm('Reset entire network? All nodes, clients, and jobs will be cleared.')) return;
  ctrl('reset');
}

function clearLog() { document.getElementById('log-out').innerHTML=''; }

function exportLog() {
  const lines=(S.recent_events??[]).map(e=>`[${e.time}] [${e.level}] ${e.msg}`).join('\n');
  const a=document.createElement('a');
  a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(lines);
  a.download='neuralgrid_log.txt';
  a.click();
}

// ── Init ───────────────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  initGraph();
  await loadGpuData();
  wsConnect();

  // Poll fallback every 3 s in case WS message was missed (belt-and-suspenders)
  setInterval(async () => {
    const snap = await call('GET', '/state');
    if (snap) applyState(snap);
  }, 3000);
});

window.addEventListener('resize', () => {
  if (svg) {
    svg.attr('viewBox', `0 0 ${svgW()} ${SVG_H}`);
    sim_force?.force('center', d3.forceCenter(svgW()/2, SVG_H/2)).alpha(.3).restart();
  }
});

// ── PATCH: fix SVG sizing and delayed init for Render deployment ───────────
// Remove the old load listener and replace with a patched version
// that waits for real DOM dimensions before drawing the graph.
(function() {
  // Override updateGraph to also fix viewBox before drawing
  const _origUpdate = updateGraph;
  window.updateGraph = function() {
    if (!svg) return;
    const W = svgW();
    svg.attr('width','100%').attr('height', SVG_H).attr('viewBox', `0 0 ${W} ${SVG_H}`);
    sim_force.force('center', d3.forceCenter(W/2, SVG_H/2));
    _origUpdate();
  };
})();
