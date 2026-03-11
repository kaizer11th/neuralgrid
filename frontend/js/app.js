/**
 * NeuralGrid — app.js v4
 * Fixed: D3 graph blank, progress bars frozen, tick counter stuck,
 *        simulation not starting, WS drops on Render free tier.
 */

// ── Config ─────────────────────────────────────────────────────────────────
const BASE = (typeof BACKEND_URL !== 'undefined' && BACKEND_URL !== '')
  ? BACKEND_URL.replace(/\/$/, '')
  : window.location.origin;

const API_BASE = BASE + '/api';
const WS_URL   = BASE.replace(/^https/, 'wss').replace(/^http/, 'ws') + '/ws';

// ── Global state ────────────────────────────────────────────────────────────
let S = {
  nodes:[], clients:[], jobs:[],
  stats:{
    total_nodes:0, busy_nodes:0, idle_nodes:0, offline_nodes:0,
    total_clients:0, total_tflops:0, utilized_tflops:0, util_pct:0,
    completed:0, failed:0, running_jobs:0, queued_jobs:0, total_earnings:0
  },
  tick:0, running:false, speed:1.0,
  util_history:[], throughput_history:[], bw_history:[],
  recent_events:[]
};

let gpuCatalog = null;
let workloads  = [];
let ws         = null;
let graphReady = false;

// ── REST ────────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  try {
    const opts = { method, headers: {'Content-Type':'application/json'} };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(API_BASE + path, opts);
    if (!res.ok) { console.error('API error', res.status, path); return null; }
    return await res.json();
  } catch(e) {
    console.error('fetch failed:', path, e.message);
    return null;
  }
}

async function ctrl(action, value) {
  const snap = await api('POST', '/sim/control', { action, value: value ?? null });
  if (snap) apply(snap);
}

// ── WebSocket ───────────────────────────────────────────────────────────────
function connectWS() {
  try { ws = new WebSocket(WS_URL); }
  catch(e) { setTimeout(connectWS, 5000); return; }

  ws.onopen = () => {
    setDot(true);
    log_ticker('WS CONNECTED');
  };
  ws.onmessage = (e) => {
    if (e.data === 'pong') return;
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'snapshot') apply(msg.data);
    } catch(_) {}
  };
  ws.onclose  = () => { setDot(false); setTimeout(connectWS, 5000); };
  ws.onerror  = () => { try { ws.close(); } catch(_){} };

  // Ping every 10 s to prevent Render from closing idle WS
  const ping = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send('ping');
    else clearInterval(ping);
  }, 10000);
}

function setDot(online) {
  const d = $('ws-dot'), l = $('ws-label');
  if (!d) return;
  d.style.background = online ? 'var(--accent)' : 'var(--danger)';
  d.style.boxShadow  = online ? '0 0 8px var(--accent)' : '0 0 8px var(--danger)';
  if (l) l.textContent = online ? 'Live' : 'Reconnecting…';
}

// ── Polling (primary state source — WS is just bonus speed) ─────────────────
// Poll every 800 ms so tick counter and progress bars update smoothly
// even when WS is dead (Render free tier kills idle connections)
setInterval(async () => {
  const snap = await api('GET', '/state');
  if (snap) apply(snap);
}, 800);

// ── Apply state ─────────────────────────────────────────────────────────────
function apply(data) {
  if (!data) return;
  S = data;
  renderAll();
  // Retry graph init if it wasn't ready yet
  if (!graphReady) tryInitGraph();
}

// ── Render pipeline ──────────────────────────────────────────────────────────
function renderAll() {
  renderHeader();
  renderNodeList();
  renderJobQueue();
  renderMetrics();
  renderLog();
  renderGraph();
  // Sync tick counter
  const tel = $('tick-val');
  if (tel) tel.textContent = S.tick ?? 0;
  // Sync start/pause button
  const btn = $('auto-btn');
  if (btn) {
    btn.textContent = S.running ? '⏸ Pause' : '⏩ Start';
    btn.className   = 'btn ' + (S.running ? 'btn-danger' : 'btn-warn');
  }
}

// ── Header ───────────────────────────────────────────────────────────────────
function renderHeader() {
  const st = S.stats;
  set('h-nodes',  `${st.total_nodes  ?? 0} Nodes`);
  set('h-jobs',   `${st.running_jobs ?? 0} Running`);
  set('h-tflops', `${st.utilized_tflops ?? 0}/${st.total_tflops ?? 0}T`);
  set('h-earn',   `$${(st.total_earnings ?? 0).toFixed(4)}`);
}

// ── Node list ─────────────────────────────────────────────────────────────────
function renderNodeList() {
  const el = $('node-list');
  if (!el) return;
  const tot = (S.nodes?.length ?? 0) + (S.clients?.length ?? 0);
  set('node-count', `${tot} total`);

  let h = '';
  for (const n of (S.nodes ?? [])) {
    const col = n.status==='idle' ? 'var(--accent)'
              : n.status==='busy' ? 'var(--accent3)' : 'var(--muted)';
    h += `<div class="node-item">
      <div class="nd" style="background:${col};box-shadow:0 0 6px ${col}"></div>
      <div class="ni">
        <div class="ni-name">${x(n.name)}
          <span style="color:#4ade80;font-size:10px">$${n.earnings.toFixed(3)}</span>
        </div>
        <div class="ni-meta">${x(n.gpu_model.replace('NVIDIA ','').replace('AMD ',''))} · ${n.vram}GB · ${x(n.location)}</div>
      </div>
      <span class="nbadge s-${n.status}">${n.status}</span>
      <button class="del-btn" onclick="delNode('${n.id}')">✕</button>
    </div>`;
  }
  for (const c of (S.clients ?? [])) {
    h += `<div class="node-item client-row">
      <div class="nd" style="background:var(--accent2);box-shadow:0 0 6px var(--accent2)"></div>
      <div class="ni">
        <div class="ni-name">${x(c.name)}</div>
        <div class="ni-meta">${x(c.workload_type)} · ${c.vram_req}GB · ${c.priority}</div>
      </div>
      <span class="nbadge s-${c.status}">${c.status}</span>
      <button class="del-btn" onclick="delClient('${c.id}')">✕</button>
    </div>`;
  }
  el.innerHTML = h || '<div style="color:var(--muted);font-size:11px;padding:20px;text-align:center">No nodes yet. Add some above.</div>';
}

// ── Job queue ─────────────────────────────────────────────────────────────────
const ICONS = { critical:'🔴', high:'🟡', normal:'🟢', low:'⚪' };

function renderJobQueue() {
  const st = S.stats;
  set('s-run',  st.running_jobs  ?? 0);
  set('s-que',  st.queued_jobs   ?? 0);
  set('s-done', st.completed     ?? 0);
  set('s-earn', '$' + (st.total_earnings ?? 0).toFixed(4));

  const el = $('job-queue');
  if (!el) return;
  const jobs = [...(S.jobs ?? [])].reverse();
  if (!jobs.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:11px;text-align:center;padding:30px">No jobs yet.</div>';
    return;
  }

  el.innerHTML = jobs.map(j => {
    const node  = (S.nodes ?? []).find(n => n.id === j.assigned_node);
    const prog  = Math.max(0, Math.min(100, Number(j.progress) || 0));
    const badge = j.status==='completed' ? 's-idle'
                : j.status==='running'   ? 's-busy'
                : j.status==='queued'    ? 's-waiting' : 's-offline';
    return `<div class="job-card ${j.status}">
      <div class="jt">
        <div>
          <div class="jname">${ICONS[j.priority]??''} ${x(j.name)}</div>
          <div class="jid">${j.id} · ${x(j.job_type)}</div>
        </div>
        <span class="nbadge ${badge}">${j.status}</span>
      </div>
      <div class="jmeta">
        <span>⚡ ${j.tflops_req}T</span>
        <span>💾 ${j.vram_req}GB</span>
        <span>🖥 ${node ? x(node.name) : '—'}</span>
        <span>⏱ ${j.ticks_left ?? j.duration_ticks}t left</span>
        ${j.estimated_cost ? `<span style="color:#4ade80">💲${j.estimated_cost}</span>` : ''}
        <span>📊 ${prog}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill ${j.status}" style="width:${prog}%"></div>
      </div>
    </div>`;
  }).join('');
}

// ── Metrics ───────────────────────────────────────────────────────────────────
function renderMetrics() {
  const st = S.stats;
  set('m-nodes',     st.total_nodes  ?? 0);
  set('m-nodes-sub', `${st.idle_nodes??0} idle · ${st.busy_nodes??0} busy`);
  set('m-tflops',    st.total_tflops ?? 0);
  set('m-util-sub',  `${st.util_pct  ?? 0}% utilized`);
  set('m-done',      st.completed    ?? 0);
  const total = (S.jobs ?? []).length;
  set('m-done-sub',  total ? `${Math.round((st.completed??0)/total*100)}% success rate` : '—');
  set('m-earn',      '$' + (st.total_earnings ?? 0).toFixed(4));
}

// ── Log ───────────────────────────────────────────────────────────────────────
function renderLog() {
  const el = $('log-out');
  if (!el) return;
  const ev = S.recent_events ?? [];
  el.innerHTML = ev.length
    ? ev.map(e => `<div class="log-line">
        <span class="log-t">[${e.time}]</span>
        <span class="log-m ${e.level}">${x(e.msg)}</span>
      </div>`).join('')
    : '<div style="color:var(--muted)">No events yet.</div>';
}

// ── Charts ─────────────────────────────────────────────────────────────────
function renderCharts() {
  drawLine('c-util', S.util_history??[],       '#00f5c4', 0, 100);
  drawLine('c-thru', S.throughput_history??[], '#7c3aed', 0);
  drawBars('c-vram');
  drawLine('c-bw',   S.bw_history??[],         '#f59e0b', 0);
}

function drawLine(id, data, color, minY=0, maxY=null) {
  const cv = $(id); if (!cv || !cv.getContext) return;
  const W = cv.offsetWidth || 400, H = 180;
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='rgba(0,0,0,.25)'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='rgba(255,255,255,.05)'; ctx.lineWidth=1;
  for(let i=0;i<5;i++){const y=H/4*i;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
  if(data.length<2) return;
  const hi=maxY??Math.max(...data,1), lo=minY;
  const sx=W/(data.length-1), sy=(H-20)/(hi-lo||1);
  const g=ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0,color+'55'); g.addColorStop(1,color+'00');
  ctx.beginPath();
  data.forEach((v,i)=>{const px=i*sx,py=H-10-(v-lo)*sy;i?ctx.lineTo(px,py):ctx.moveTo(px,py);});
  ctx.lineTo((data.length-1)*sx,H);ctx.lineTo(0,H);ctx.closePath();
  ctx.fillStyle=g;ctx.fill();
  ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=2.5;
  ctx.shadowBlur=10;ctx.shadowColor=color;
  data.forEach((v,i)=>{const px=i*sx,py=H-10-(v-lo)*sy;i?ctx.lineTo(px,py):ctx.moveTo(px,py);});
  ctx.stroke();ctx.shadowBlur=0;
  const lx=(data.length-1)*sx, ly=H-10-(data[data.length-1]-lo)*sy;
  ctx.beginPath();ctx.arc(lx,ly,4,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
  ctx.fillStyle='rgba(148,163,184,.9)';ctx.font='10px Space Mono,monospace';
  ctx.fillText(String(data[data.length-1]),Math.min(lx+6,W-32),ly+4);
}

function drawBars(id) {
  const cv=$(id);if(!cv||!cv.getContext)return;
  const W=cv.offsetWidth||400,H=180;
  cv.width=W;cv.height=H;
  const ctx=cv.getContext('2d');
  ctx.clearRect(0,0,W,H);ctx.fillStyle='rgba(0,0,0,.25)';ctx.fillRect(0,0,W,H);
  const nodes=(S.nodes??[]).slice(0,8);
  if(!nodes.length){
    ctx.fillStyle='rgba(100,116,139,.6)';ctx.font='11px Space Mono,monospace';
    ctx.textAlign='center';ctx.fillText('Add nodes to see chart',W/2,H/2);return;
  }
  const mx=Math.max(...nodes.map(n=>n.vram),1);
  nodes.forEach((n,i)=>{
    const slot=(W-40)/nodes.length,bw=Math.min(50,slot-8),px=20+i*slot;
    const bh=(n.vram/mx)*(H-50),py=H-30-bh;
    const col=n.status==='busy'?'#f59e0b':n.status==='offline'?'#475569':'#00f5c4';
    const g=ctx.createLinearGradient(0,py,0,H-30);
    g.addColorStop(0,col+'cc');g.addColorStop(1,col+'22');
    ctx.fillStyle=g;ctx.beginPath();
    ctx.roundRect?ctx.roundRect(px,py,bw,bh,3):ctx.rect(px,py,bw,bh);
    ctx.fill();
    ctx.fillStyle=col;ctx.font='9px Space Mono,monospace';ctx.textAlign='center';
    ctx.fillText(n.vram+'G',px+bw/2,py-4);
    ctx.fillStyle='rgba(100,116,139,.9)';ctx.fillText(n.name.slice(0,6),px+bw/2,H-14);
  });
  ctx.textAlign='left';
}

// ── D3 Network graph ──────────────────────────────────────────────────────────
let svgEl=null, force=null, lSel=null, nSel=null;
const GH = 500;

function svgWidth() {
  const el = document.getElementById('network-svg');
  if (!el) return 700;
  // Try bounding rect first, fall back to parent
  let w = el.getBoundingClientRect().width;
  if (w < 50) w = el.parentElement?.getBoundingClientRect().width ?? 0;
  if (w < 50) w = window.innerWidth * 0.65;
  return Math.max(w, 300);
}

function tryInitGraph() {
  const el = document.getElementById('network-svg');
  if (!el) return;
  const w = svgWidth();
  if (w < 100) {
    // Not ready yet — retry in 200 ms
    setTimeout(tryInitGraph, 200);
    return;
  }
  buildGraph(w);
}

function buildGraph(W) {
  const el = document.getElementById('network-svg');
  el.innerHTML = '';

  svgEl = d3.select('#network-svg')
    .attr('width', '100%')
    .attr('height', GH)
    .attr('viewBox', `0 0 ${W} ${GH}`)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  // Glow filters
  const defs = svgEl.append('defs');
  [['gn','#00f5c4'],['gp','#7c3aed'],['ga','#f59e0b']].forEach(([id,c]) => {
    const f = defs.append('filter').attr('id', id);
    f.append('feGaussianBlur').attr('stdDeviation','3').attr('result','b');
    const m = f.append('feMerge');
    m.append('feMergeNode').attr('in','b');
    m.append('feMergeNode').attr('in','SourceGraphic');
  });

  svgEl.append('g').attr('class','links-g');
  svgEl.append('g').attr('class','nodes-g');

  force = d3.forceSimulation()
    .force('link',   d3.forceLink().id(d=>d.id).distance(150).strength(0.45))
    .force('charge', d3.forceManyBody().strength(-350))
    .force('center', d3.forceCenter(W/2, GH/2))
    .force('coll',   d3.forceCollide(46))
    .alphaDecay(0.015)
    .on('tick', gTick);

  graphReady = true;
  console.log('D3 graph initialised, W =', W);
  // Immediately draw with current state
  renderGraph();
}

function gData() {
  const hub = { id:'hub', type:'hub', label:'HUB', sub:'Coordinator' };
  const nodes = [
    hub,
    ...(S.nodes??[]).map(n => ({
      id: n.id, type:'provider',
      label: n.name.slice(0,12),
      sub:   n.gpu_model.replace('NVIDIA ','').replace('AMD ','').slice(0,14),
      data:  n,
    })),
    ...(S.clients??[]).map(c => ({
      id: c.id, type:'client',
      label: c.name.slice(0,12),
      sub:   c.workload_type,
      data:  c,
    })),
  ];
  const links = [];
  (S.nodes??[]).forEach(n =>
    links.push({ source:'hub', target:n.id, active:n.status==='busy', isC:false })
  );
  (S.clients??[]).forEach(c => {
    links.push({ source:'hub', target:c.id, active:c.status==='active', isC:true });
    if (c.assigned_node)
      links.push({ source:c.id, target:c.assigned_node, active:true, isC:true });
  });
  return { nodes, links };
}

function renderGraph() {
  if (!svgEl || !force || !graphReady) return;

  const W = svgWidth();
  svgEl.attr('viewBox', `0 0 ${W} ${GH}`);
  force.force('center', d3.forceCenter(W/2, GH/2));

  const { nodes, links } = gData();

  // Preserve positions of existing nodes
  const pos = {};
  (force.nodes() || []).forEach(n => { pos[n.id] = {x:n.x, y:n.y, vx:n.vx, vy:n.vy}; });
  nodes.forEach(n => {
    if (pos[n.id]) Object.assign(n, pos[n.id]);
    if (n.id === 'hub') { n.fx = W/2; n.fy = GH/2; }
  });

  // Links
  lSel = svgEl.select('.links-g').selectAll('line')
    .data(links, d => {
      const s = d.source?.id ?? d.source;
      const t = d.target?.id ?? d.target;
      return s + '-' + t;
    });
  lSel.exit().remove();
  lSel = lSel.enter().append('line').merge(lSel)
    .attr('class', d => 'link' + (d.active?' active-job':'') + (d.isC?' client-link':''));

  // Nodes
  nSel = svgEl.select('.nodes-g').selectAll('g.ng').data(nodes, d => d.id);
  nSel.exit().remove();

  const entered = nSel.enter().append('g')
    .attr('class', d => 'ng node-' + d.type)
    .call(d3.drag()
      .on('start', (e,d) => { if(!e.active) force.alphaTarget(.3).restart(); d.fx=d.x;d.fy=d.y; })
      .on('drag',  (e,d) => { d.fx=e.x; d.fy=e.y; })
      .on('end',   (e,d) => { if(!e.active) force.alphaTarget(0); if(d.id!=='hub'){d.fx=null;d.fy=null;} }))
    .on('mouseover', showTip)
    .on('mousemove',  moveTip)
    .on('mouseout',   hideTip);

  entered.append('circle')
    .attr('r',      d => d.type==='hub'?30:d.type==='provider'?22:18)
    .attr('filter', d => d.type==='hub'?'url(#ga)':d.type==='provider'?'url(#gn)':'url(#gp)');
  entered.append('text').attr('class','node-label').attr('dy','4');
  entered.append('text').attr('class','node-sublabel').attr('dy','18');

  nSel = entered.merge(nSel);
  nSel.select('.node-label').text(d => d.label);
  nSel.select('.node-sublabel').text(d => d.type!=='hub' ? d.sub : 'COORDINATOR');
  nSel.select('circle').attr('stroke', d => {
    if (d.type==='provider' && d.data)
      return d.data.status==='busy' ? 'var(--accent3)'
           : d.data.status==='offline' ? 'var(--muted)' : 'var(--accent)';
    return d.type==='client' ? 'var(--accent2)' : 'var(--accent3)';
  });

  force.nodes(nodes);
  force.force('link').links(links);
  force.alpha(0.3).restart();
}

function gTick() {
  if (!lSel || !nSel) return;
  lSel.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
      .attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
  nSel.attr('transform',d=>`translate(${d.x},${d.y})`);
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
function showTip(event, d) {
  const tt=$('tooltip'); if(!tt) return;
  $('tt-title').textContent = d.label || 'Hub';
  const b=$('tt-body');
  if (d.type==='hub') {
    b.innerHTML=row('Nodes',S.nodes?.length??0)+row('Clients',S.clients?.length??0)+row('Tick','#'+S.tick);
  } else if(d.type==='provider'&&d.data) {
    const n=d.data;
    b.innerHTML=row('GPU',n.gpu_model)+row('VRAM',n.vram+'GB')+row('TFLOPS',n.tflops)
      +row('Status',n.status)+row('Location',n.location)
      +row('Earnings','$'+n.earnings.toFixed(4))+row('Vast.ai/hr','$'+n.vastai_rate);
  } else if(d.type==='client'&&d.data) {
    const c=d.data;
    b.innerHTML=row('Workload',c.workload_type)+row('VRAM req',c.vram_req+'GB')
      +row('Priority',c.priority)+row('Status',c.status)+row('Jobs',c.jobs_submitted);
  }
  tt.classList.remove('hidden');
  moveTip(event);
}
function row(k,v){return`<div class="tt-row"><span>${k}</span><span>${v}</span></div>`;}
function moveTip(e){
  const tt=$('tooltip');if(!tt)return;
  let tx=e.clientX+14,ty=e.clientY-10;
  if(tx+200>window.innerWidth)tx=e.clientX-215;
  tt.style.left=tx+'px';tt.style.top=ty+'px';
}
function hideTip(){$('tooltip')?.classList.add('hidden');}

// ── Ticker ────────────────────────────────────────────────────────────────────
function log_ticker(msg,cls=''){
  const el=$('ticker-text');if(!el)return;
  const sp=document.createElement('span');
  if(cls)sp.className=cls;
  sp.textContent='● '+msg;
  el.prepend(sp);
  while(el.children.length>14)el.lastElementChild.remove();
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(btn){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  const name=btn.dataset.tab;
  document.getElementById('view-'+name)?.classList.add('active');
  btn.classList.add('active');
  if(name==='analytics')setTimeout(renderCharts,60);
}

// ── GPU catalog ───────────────────────────────────────────────────────────────
async function loadCatalog() {
  const data = await api('GET','/gpus');
  if (!data) { console.error('Could not load GPU catalog'); return; }
  gpuCatalog = data;
  workloads  = data.workloads || [];

  const gpuSel = $('p-gpu');
  if (gpuSel) {
    gpuSel.innerHTML = data.gpus.map(g=>`<option value="${g.model}">${g.model}</option>`).join('');
    previewGpu(data.gpus[0]?.model);
  }
  const wlHtml = workloads.map(w=>`<option value="${w.type}">${w.icon||''} ${w.name}</option>`).join('');
  const cwl=$('c-wl'); if(cwl) cwl.innerHTML=wlHtml;
  const pre=$('j-preset');
  if(pre) pre.innerHTML='<option value="">— Custom —</option>'
    +workloads.map(w=>`<option value="${w.name}">${w.icon||''} ${w.name}</option>`).join('');
  renderGpuTable(data.gpus);
}

function previewGpu(model){
  if(!gpuCatalog)return;
  const g=gpuCatalog.gpus.find(g=>g.model===model);if(!g)return;
  const el=$('gpu-preview');if(!el)return;
  el.innerHTML=`<div class="gp-grid">
    <span class="gp-k">VRAM</span><span class="gp-v" style="color:var(--accent)">${g.vram_gb}GB ${g.vram_type}</span>
    <span class="gp-k">FP32 T</span><span class="gp-v" style="color:var(--accent)">${g.tflops_fp32}</span>
    <span class="gp-k">FP16 T</span><span class="gp-v">${g.tflops_fp16}</span>
    <span class="gp-k">TDP</span><span class="gp-v">${g.tdp_watts}W</span>
    <span class="gp-k">Market</span><span class="gp-v" style="color:var(--accent3)">$${g.market_price_usd.toLocaleString()}</span>
    <span class="gp-k">Salad/hr</span><span class="gp-v" style="color:#4ade80">$${g.salad_rate_per_hour}</span>
    <span class="gp-k">Vast.ai/hr</span><span class="gp-v" style="color:#4ade80">$${g.vastai_rate_per_hour}</span>
    <span class="gp-k">Tier</span><span class="gp-v"><span class="tier ${g.tier}">${g.tier}</span></span>
  </div>`;
}

function renderGpuTable(gpus){
  const el=$('gpu-tbody');if(!el)return;
  el.innerHTML=gpus.map(g=>`<tr>
    <td><strong>${g.model}</strong><br><span style="color:var(--muted);font-size:10px">${g.architecture} · ${g.release_year}</span></td>
    <td><span class="tier ${g.tier}">${g.tier}</span></td>
    <td style="color:var(--accent)">${g.vram_gb}GB<br><span style="color:var(--muted);font-size:10px">${g.vram_type}</span></td>
    <td style="color:var(--accent)">${g.tflops_fp32}</td>
    <td>${g.tflops_fp16}</td>
    <td>${g.memory_bandwidth_gbps}</td>
    <td style="color:var(--accent3)">${g.tdp_watts}W</td>
    <td>$${g.market_price_usd.toLocaleString()}</td>
    <td style="color:#4ade80">$${g.vastai_rate_per_hour}/hr</td>
    <td style="color:#4ade80">$${g.salad_rate_per_hour}/hr</td>
  </tr>`).join('');
}

function applyPreset(name){
  const wl=workloads.find(w=>w.name===name);if(!wl)return;
  val('j-vram',wl.min_vram_gb);val('j-tflops',wl.tflops_required);
  val('j-dur',wl.avg_duration_ticks);
  val('j-name',wl.name+' #'+Math.floor(Math.random()*99+1));
}

function refreshClientSel(){
  const sel=$('j-client');if(!sel)return;
  sel.innerHTML='<option value="">— None —</option>'
    +(S.clients??[]).map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
}

// ── Actions ───────────────────────────────────────────────────────────────────
let pN=1, cN=1;

async function addNode(){
  const model=get('p-gpu');if(!model)return;
  const name=get('p-name').trim()||`GPU_NODE_${String(pN).padStart(3,'0')}`;
  await api('POST','/nodes',{name,gpu_model:model,bandwidth_gbps:parseFloat(get('p-bw'))||10,location:get('p-loc')});
  val('p-name','');pN++;
}
async function addClient(){
  const name=get('c-name').trim()||`CLIENT_${String(cN).padStart(3,'0')}`;
  await api('POST','/clients',{name,workload_type:get('c-wl'),vram_req:parseInt(get('c-vram'))||12,priority:get('c-prio')});
  val('c-name','');cN++;
}
async function submitJob(){
  const name=get('j-name').trim()||`JOB_${Date.now().toString(36).toUpperCase()}`;
  await api('POST','/jobs',{name,job_type:get('j-preset')||'Custom',
    vram_req:parseInt(get('j-vram'))||8,tflops_req:parseInt(get('j-tflops'))||20,
    duration_ticks:parseInt(get('j-dur'))||5,priority:get('j-prio'),
    client_id:get('j-client')||null});
  val('j-name','');
}
async function submitRandom(){ await api('POST','/jobs/random',{}); }
async function clearDone()   { await api('DELETE','/jobs/completed'); }
async function delNode(id)   { await api('DELETE','/nodes/'+id); }
async function delClient(id) { await api('DELETE','/clients/'+id); }

function ctrlStep()  { ctrl('step'); }
function ctrlToggle(){ ctrl(S.running?'stop':'start'); }
function ctrlSpeed(v){ ctrl('speed',parseFloat(v)); }
function ctrlReset(){
  if(!confirm('Reset entire network? All nodes, clients and jobs will be cleared.'))return;
  ctrl('reset');
}
function clearLog(){ const el=$('log-out');if(el)el.innerHTML=''; }
function exportLog(){
  const txt=(S.recent_events??[]).map(e=>`[${e.time}] [${e.level}] ${e.msg}`).join('\n');
  const a=document.createElement('a');
  a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(txt);
  a.download='neuralgrid_log.txt';a.click();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function $(id)     { return document.getElementById(id); }
function set(id,v) { const e=$(id);if(e)e.textContent=v; }
function get(id)   { const e=$(id);return e?e.value:''; }
function val(id,v) { const e=$(id);if(e)e.value=v; }
function x(s)      { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  // Load GPU catalog from backend
  loadCatalog();

  // Connect WebSocket
  connectWS();

  // Init graph — try immediately, then retry every 300ms until SVG has width
  setTimeout(tryInitGraph, 100);

  // Keep client dropdown in sync
  setInterval(refreshClientSel, 2000);
});

window.addEventListener('resize', () => {
  if (!svgEl || !force) return;
  const W = svgWidth();
  svgEl.attr('viewBox',`0 0 ${W} ${GH}`);
  force.force('center', d3.forceCenter(W/2, GH/2)).alpha(0.2).restart();
});
