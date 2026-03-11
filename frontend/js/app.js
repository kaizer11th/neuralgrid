/**
 * NeuralGrid — app.js v5
 * Pure Canvas force-directed graph — no D3, no SVG sizing issues.
 * Works on every browser, every deployment.
 */

// ── Config ──────────────────────────────────────────────────────────────────
const BASE = (typeof BACKEND_URL !== 'undefined' && BACKEND_URL !== '')
  ? BACKEND_URL.replace(/\/$/, '')
  : window.location.origin;

const API_BASE = BASE + '/api';
const WS_URL   = BASE.replace(/^https/, 'wss').replace(/^http/, 'ws') + '/ws';

// ── Global state ─────────────────────────────────────────────────────────────
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

// ── REST ──────────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  try {
    const opts = { method, headers: {'Content-Type':'application/json'} };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(API_BASE + path, opts);
    if (!res.ok) { console.error('API', res.status, path); return null; }
    return await res.json();
  } catch(e) { console.error('fetch:', path, e.message); return null; }
}

async function ctrl(action, value) {
  const snap = await api('POST', '/sim/control', { action, value: value ?? null });
  if (snap) apply(snap);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  try { ws = new WebSocket(WS_URL); }
  catch(e) { setTimeout(connectWS, 5000); return; }
  ws.onopen    = () => { setDot(true); };
  ws.onmessage = (e) => {
    if (e.data === 'pong') return;
    try { const m = JSON.parse(e.data); if (m.type==='snapshot') apply(m.data); } catch(_){}
  };
  ws.onclose  = () => { setDot(false); setTimeout(connectWS, 5000); };
  ws.onerror  = () => { try{ws.close();}catch(_){} };
  setInterval(()=>{ if(ws?.readyState===1) ws.send('ping'); }, 10000);
}

function setDot(on) {
  const d=$i('ws-dot'), l=$i('ws-label');
  if(!d) return;
  d.style.background = on ? 'var(--accent)' : 'var(--danger)';
  d.style.boxShadow  = on ? '0 0 8px var(--accent)' : '0 0 8px var(--danger)';
  if(l) l.textContent = on ? 'Live' : 'Reconnecting…';
}

// ── Polling — primary update driver ──────────────────────────────────────────
setInterval(async () => {
  const snap = await api('GET', '/state');
  if (snap) apply(snap);
}, 800);

// ── Apply state ───────────────────────────────────────────────────────────────
function apply(data) {
  if (!data) return;
  S = data;
  renderAll();
}

// ── Render all ────────────────────────────────────────────────────────────────
function renderAll() {
  renderHeader();
  renderNodeList();
  renderJobQueue();
  renderMetrics();
  renderLog();
  graphDraw();   // canvas graph — always works
  const tel = $i('tick-val');
  if (tel) tel.textContent = S.tick ?? 0;
  const btn = $i('auto-btn');
  if (btn) {
    btn.textContent = S.running ? '⏸ Pause' : '⏩ Start';
    btn.className   = 'btn ' + (S.running ? 'btn-danger' : 'btn-warn');
  }
}

// ── Header ────────────────────────────────────────────────────────────────────
function renderHeader() {
  const st = S.stats;
  txt('h-nodes',  `${st.total_nodes??0} Nodes`);
  txt('h-jobs',   `${st.running_jobs??0} Running`);
  txt('h-tflops', `${st.utilized_tflops??0}/${st.total_tflops??0}T`);
  txt('h-earn',   `$${(st.total_earnings??0).toFixed(4)}`);
}

// ── Node list ─────────────────────────────────────────────────────────────────
function renderNodeList() {
  const el = $i('node-list'); if (!el) return;
  txt('node-count', `${(S.nodes?.length??0)+(S.clients?.length??0)} total`);
  let h = '';
  for (const n of (S.nodes??[])) {
    const c = n.status==='idle'?'var(--accent)':n.status==='busy'?'var(--accent3)':'var(--muted)';
    h += `<div class="node-item">
      <div class="nd" style="background:${c};box-shadow:0 0 6px ${c}"></div>
      <div class="ni">
        <div class="ni-name">${esc(n.name)} <span style="color:#4ade80;font-size:10px">$${n.earnings.toFixed(3)}</span></div>
        <div class="ni-meta">${esc(n.gpu_model.replace('NVIDIA ','').replace('AMD ',''))} · ${n.vram}GB · ${esc(n.location)}</div>
      </div>
      <span class="nbadge s-${n.status}">${n.status}</span>
      <button class="del-btn" onclick="delNode('${n.id}')">✕</button>
    </div>`;
  }
  for (const c of (S.clients??[])) {
    h += `<div class="node-item client-row">
      <div class="nd" style="background:var(--accent2);box-shadow:0 0 6px var(--accent2)"></div>
      <div class="ni">
        <div class="ni-name">${esc(c.name)}</div>
        <div class="ni-meta">${esc(c.workload_type)} · ${c.vram_req}GB · ${c.priority}</div>
      </div>
      <span class="nbadge s-${c.status}">${c.status}</span>
      <button class="del-btn" onclick="delClient('${c.id}')">✕</button>
    </div>`;
  }
  el.innerHTML = h || '<div style="color:var(--muted);font-size:11px;padding:20px;text-align:center">No nodes yet. Add some above.</div>';
}

// ── Job queue ─────────────────────────────────────────────────────────────────
const PICO = {critical:'🔴',high:'🟡',normal:'🟢',low:'⚪'};

function renderJobQueue() {
  const st = S.stats;
  txt('s-run',  st.running_jobs??0);
  txt('s-que',  st.queued_jobs??0);
  txt('s-done', st.completed??0);
  txt('s-earn', '$'+(st.total_earnings??0).toFixed(4));
  const el = $i('job-queue'); if (!el) return;
  const jobs = [...(S.jobs??[])].reverse();
  if (!jobs.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:11px;text-align:center;padding:30px">No jobs yet.</div>';
    return;
  }
  el.innerHTML = jobs.map(j => {
    const node  = (S.nodes??[]).find(n=>n.id===j.assigned_node);
    const prog  = Math.max(0, Math.min(100, Number(j.progress)||0));
    const badge = j.status==='completed'?'s-idle':j.status==='running'?'s-busy':j.status==='queued'?'s-waiting':'s-offline';
    return `<div class="job-card ${j.status}">
      <div class="jt">
        <div>
          <div class="jname">${PICO[j.priority]??''} ${esc(j.name)}</div>
          <div class="jid">${j.id} · ${esc(j.job_type)}</div>
        </div>
        <span class="nbadge ${badge}">${j.status}</span>
      </div>
      <div class="jmeta">
        <span>⚡ ${j.tflops_req}T</span><span>💾 ${j.vram_req}GB</span>
        <span>🖥 ${node?esc(node.name):'—'}</span>
        <span>⏱ ${j.ticks_left??j.duration_ticks}t left</span>
        ${j.estimated_cost?`<span style="color:#4ade80">💲${j.estimated_cost}</span>`:''}
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
  txt('m-nodes',    st.total_nodes??0);
  txt('m-nodes-sub',`${st.idle_nodes??0} idle · ${st.busy_nodes??0} busy`);
  txt('m-tflops',   st.total_tflops??0);
  txt('m-util-sub', `${st.util_pct??0}% utilized`);
  txt('m-done',     st.completed??0);
  const total=(S.jobs??[]).length;
  txt('m-done-sub', total?`${Math.round((st.completed??0)/total*100)}% success rate`:'—');
  txt('m-earn',     '$'+(st.total_earnings??0).toFixed(4));
}

// ── Log ───────────────────────────────────────────────────────────────────────
function renderLog() {
  const el=$i('log-out');if(!el)return;
  const ev=S.recent_events??[];
  el.innerHTML=ev.length
    ?ev.map(e=>`<div class="log-line"><span class="log-t">[${e.time}]</span><span class="log-m ${e.level}">${esc(e.msg)}</span></div>`).join('')
    :'<div style="color:var(--muted)">No events yet.</div>';
}

// ── Charts ────────────────────────────────────────────────────────────────────
function renderCharts() {
  drawLine('c-util',S.util_history??[],'#00f5c4',0,100);
  drawLine('c-thru',S.throughput_history??[],'#7c3aed',0);
  drawBars('c-vram');
  drawLine('c-bw',S.bw_history??[],'#f59e0b',0);
}

function drawLine(id,data,color,minY=0,maxY=null){
  const cv=$i(id);if(!cv||!cv.getContext)return;
  const W=cv.offsetWidth||400,H=180;cv.width=W;cv.height=H;
  const ctx=cv.getContext('2d');
  ctx.fillStyle='rgba(0,0,0,.25)';ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='rgba(255,255,255,.05)';ctx.lineWidth=1;
  for(let i=0;i<5;i++){const y=H/4*i;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
  if(data.length<2)return;
  const hi=maxY??Math.max(...data,1),lo=minY;
  const sx=W/(data.length-1),sy=(H-20)/(hi-lo||1);
  const g=ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0,color+'55');g.addColorStop(1,color+'00');
  ctx.beginPath();
  data.forEach((v,i)=>{const px=i*sx,py=H-10-(v-lo)*sy;i?ctx.lineTo(px,py):ctx.moveTo(px,py);});
  ctx.lineTo((data.length-1)*sx,H);ctx.lineTo(0,H);ctx.closePath();
  ctx.fillStyle=g;ctx.fill();
  ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=2.5;ctx.shadowBlur=10;ctx.shadowColor=color;
  data.forEach((v,i)=>{const px=i*sx,py=H-10-(v-lo)*sy;i?ctx.lineTo(px,py):ctx.moveTo(px,py);});
  ctx.stroke();ctx.shadowBlur=0;
  const lx=(data.length-1)*sx,ly=H-10-(data[data.length-1]-lo)*sy;
  ctx.beginPath();ctx.arc(lx,ly,4,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
  ctx.fillStyle='rgba(148,163,184,.9)';ctx.font='10px Space Mono,monospace';
  ctx.fillText(String(data[data.length-1]),Math.min(lx+6,W-32),ly+4);
}

function drawBars(id){
  const cv=$i(id);if(!cv||!cv.getContext)return;
  const W=cv.offsetWidth||400,H=180;cv.width=W;cv.height=H;
  const ctx=cv.getContext('2d');
  ctx.fillStyle='rgba(0,0,0,.25)';ctx.fillRect(0,0,W,H);
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

// ════════════════════════════════════════════════════════════════════════════
//  PURE CANVAS FORCE-DIRECTED GRAPH
//  No D3, no SVG. Always renders. Physics sim runs in JS, draws on Canvas.
// ════════════════════════════════════════════════════════════════════════════
const GRAPH = {
  nodes: [],   // { id, type, label, sub, x, y, vx, vy, data }
  links: [],   // { source, target, active, isC }
  canvas: null,
  ctx: null,
  W: 0, H: 520,
  raf: null,
  hoverId: null,
  dragging: null,
  dragOffX: 0, dragOffY: 0,

  init() {
    this.canvas = document.getElementById('network-canvas');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    this.canvas.addEventListener('mousedown', (e) => this.onDown(e));
    this.canvas.addEventListener('mouseup',   ()  => this.onUp());
    this.canvas.addEventListener('mouseleave',()  => { this.hoverId=null; this.onUp(); });
    this.loop();
  },

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    this.W = rect.width || this.canvas.parentElement?.clientWidth || 700;
    this.H = 520;
    this.canvas.width  = this.W;
    this.canvas.height = this.H;
  },

  // Sync nodes/links from app state S
  sync() {
    const hub = { id:'hub', type:'hub', label:'HUB', sub:'Coordinator',
                  x: this.W/2, y: this.H/2, vx:0, vy:0, data:null };

    const newIds = new Set(['hub',
      ...(S.nodes??[]).map(n=>n.id),
      ...(S.clients??[]).map(c=>c.id)
    ]);

    // Remove nodes that no longer exist
    this.nodes = this.nodes.filter(n => newIds.has(n.id));

    const existById = {};
    this.nodes.forEach(n => existById[n.id] = n);

    // Hub
    if (!existById['hub']) {
      this.nodes.push(hub);
    } else {
      // Hub stays fixed at center
      existById['hub'].x = this.W/2;
      existById['hub'].y = this.H/2;
      existById['hub'].vx = 0;
      existById['hub'].vy = 0;
    }

    // Provider nodes
    for (const n of (S.nodes??[])) {
      if (existById[n.id]) {
        existById[n.id].data = n;
      } else {
        // Spawn near center with slight random offset
        this.nodes.push({
          id: n.id, type:'provider',
          label: n.name.slice(0,12),
          sub:   n.gpu_model.replace('NVIDIA ','').replace('AMD ','').slice(0,14),
          x: this.W/2 + (Math.random()-0.5)*200,
          y: this.H/2 + (Math.random()-0.5)*200,
          vx:0, vy:0, data:n
        });
      }
    }

    // Client nodes
    for (const c of (S.clients??[])) {
      if (existById[c.id]) {
        existById[c.id].data = c;
      } else {
        this.nodes.push({
          id: c.id, type:'client',
          label: c.name.slice(0,12),
          sub:   c.workload_type,
          x: this.W/2 + (Math.random()-0.5)*250,
          y: this.H/2 + (Math.random()-0.5)*250,
          vx:0, vy:0, data:c
        });
      }
    }

    // Links
    this.links = [];
    (S.nodes??[]).forEach(n => this.links.push({source:'hub',target:n.id,active:n.status==='busy',isC:false}));
    (S.clients??[]).forEach(c => {
      this.links.push({source:'hub',target:c.id,active:c.status==='active',isC:true});
      if (c.assigned_node) this.links.push({source:c.id,target:c.assigned_node,active:true,isC:true});
    });
  },

  // Force-directed physics tick
  tick() {
    const byId = {};
    this.nodes.forEach(n => byId[n.id] = n);

    const repel  = 6000;
    const spring = 0.012;
    const rest   = 140;
    const damp   = 0.82;
    const dt     = 1;

    // Repulsion between every pair
    for (let i=0;i<this.nodes.length;i++) {
      for (let j=i+1;j<this.nodes.length;j++) {
        const a=this.nodes[i], b=this.nodes[j];
        let dx=b.x-a.x, dy=b.y-a.y;
        const d2=dx*dx+dy*dy+1;
        const d=Math.sqrt(d2);
        const f=repel/d2;
        const fx=f*dx/d, fy=f*dy/d;
        if(a.id!=='hub'){a.vx-=fx*dt;a.vy-=fy*dt;}
        if(b.id!=='hub'){b.vx+=fx*dt;b.vy+=fy*dt;}
      }
    }

    // Spring forces along links
    for (const lk of this.links) {
      const a=byId[lk.source], b=byId[lk.target];
      if(!a||!b) continue;
      const dx=b.x-a.x, dy=b.y-a.y;
      const d=Math.sqrt(dx*dx+dy*dy)||1;
      const f=spring*(d-rest);
      const fx=f*dx/d, fy=f*dy/d;
      if(a.id!=='hub'){a.vx+=fx*dt;a.vy+=fy*dt;}
      if(b.id!=='hub'){b.vx-=fx*dt;b.vy-=fy*dt;}
    }

    // Centering pull (weak)
    for (const n of this.nodes) {
      if(n.id==='hub') continue;
      n.vx += (this.W/2-n.x)*0.0008;
      n.vy += (this.H/2-n.y)*0.0008;
    }

    // Integrate + dampen + clamp to canvas
    for (const n of this.nodes) {
      if(n.id==='hub'){ n.x=this.W/2; n.y=this.H/2; continue; }
      if(this.dragging===n.id) continue;
      n.vx*=damp; n.vy*=damp;
      n.x+=n.vx*dt; n.y+=n.vy*dt;
      n.x=Math.max(32,Math.min(this.W-32,n.x));
      n.y=Math.max(32,Math.min(this.H-32,n.y));
    }
  },

  draw() {
    const ctx = this.ctx;
    const W=this.W, H=this.H;
    ctx.clearRect(0,0,W,H);

    // Background
    ctx.fillStyle='rgba(5,8,16,0.92)';
    ctx.fillRect(0,0,W,H);

    // Grid
    ctx.strokeStyle='rgba(0,245,196,0.03)';ctx.lineWidth=1;
    for(let x=0;x<W;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
    for(let y=0;y<H;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}

    if (this.nodes.length === 0) {
      ctx.fillStyle='rgba(100,116,139,0.5)';
      ctx.font='13px Space Mono,monospace';
      ctx.textAlign='center';
      ctx.fillText('Add GPU provider nodes to see the network', W/2, H/2-12);
      ctx.font='11px Space Mono,monospace';
      ctx.fillText('Use the "+ Add GPU Provider" panel on the right →', W/2, H/2+12);
      ctx.textAlign='left';
      return;
    }

    const byId = {};
    this.nodes.forEach(n => byId[n.id] = n);

    // Draw links
    for (const lk of this.links) {
      const a=byId[lk.source], b=byId[lk.target];
      if(!a||!b) continue;
      ctx.save();
      if (lk.active) {
        const col = lk.isC ? '#7c3aed' : '#00f5c4';
        ctx.strokeStyle = col;
        ctx.lineWidth   = 2;
        ctx.shadowBlur  = 8;
        ctx.shadowColor = col;
        // Animated dashes
        ctx.setLineDash([8,5]);
        ctx.lineDashOffset = -(Date.now()/40 % 26);
      } else {
        ctx.strokeStyle = lk.isC ? 'rgba(124,58,237,0.2)' : 'rgba(0,245,196,0.12)';
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([]);
      }
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
      ctx.restore();
    }

    // Draw nodes
    for (const n of this.nodes) {
      const isHover = this.hoverId===n.id;
      let col, r;

      if (n.type==='hub') {
        col='#f59e0b'; r=28;
      } else if (n.type==='provider') {
        const st=n.data?.status;
        col = st==='busy'?'#f59e0b':st==='offline'?'#64748b':'#00f5c4';
        r=22;
      } else {
        col='#7c3aed'; r=18;
      }

      if(isHover) r+=4;

      // Glow
      ctx.save();
      ctx.shadowBlur  = isHover ? 20 : 12;
      ctx.shadowColor = col;

      // Circle fill
      const grad=ctx.createRadialGradient(n.x,n.y,0,n.x,n.y,r);
      grad.addColorStop(0, col+'33');
      grad.addColorStop(1, col+'08');
      ctx.fillStyle=grad;
      ctx.beginPath();ctx.arc(n.x,n.y,r,0,Math.PI*2);ctx.fill();

      // Circle stroke
      ctx.strokeStyle=col;
      ctx.lineWidth=isHover?2.5:2;
      ctx.beginPath();ctx.arc(n.x,n.y,r,0,Math.PI*2);ctx.stroke();
      ctx.restore();

      // Label
      ctx.fillStyle='#e2e8f0';
      ctx.font='bold 10px Space Mono,monospace';
      ctx.textAlign='center';
      ctx.fillText(n.label, n.x, n.y+4);

      // Sub-label
      ctx.fillStyle='rgba(100,116,139,0.9)';
      ctx.font='8px Space Mono,monospace';
      ctx.fillText(n.sub||'', n.x, n.y+16);
      ctx.textAlign='left';

      // Status dot for provider nodes
      if (n.type==='provider' && n.data) {
        const st=n.data.status;
        const dc=st==='busy'?'#f59e0b':st==='offline'?'#64748b':'#4ade80';
        ctx.save();ctx.shadowBlur=6;ctx.shadowColor=dc;
        ctx.fillStyle=dc;ctx.beginPath();ctx.arc(n.x+r-4,n.y-r+4,5,0,Math.PI*2);ctx.fill();
        ctx.restore();
      }
    }

    // Tooltip
    if (this.hoverId) {
      const n=byId[this.hoverId];
      if(n) this.drawTooltip(ctx,n);
    }

    ctx.textAlign='left';
  },

  drawTooltip(ctx, n) {
    const lines=[];
    if(n.type==='hub') {
      lines.push(['Nodes', S.nodes?.length??0],['Clients',S.clients?.length??0],['Tick','#'+S.tick]);
    } else if(n.type==='provider'&&n.data) {
      const d=n.data;
      lines.push(['GPU',d.gpu_model],['VRAM',d.vram+'GB'],['TFLOPS',d.tflops],
        ['Status',d.status],['Location',d.location],['Earnings','$'+d.earnings.toFixed(4)],
        ['Vast.ai/hr','$'+d.vastai_rate]);
    } else if(n.type==='client'&&n.data) {
      const d=n.data;
      lines.push(['Workload',d.workload_type],['VRAM req',d.vram_req+'GB'],
        ['Priority',d.priority],['Status',d.status],['Jobs',d.jobs_submitted]);
    }
    const pad=10, lh=18, tw=190;
    const th=pad*2+lh*lines.length+20;
    let tx=n.x+32, ty=n.y-th/2;
    if(tx+tw>this.W-10) tx=n.x-tw-32;
    ty=Math.max(10,Math.min(this.H-th-10,ty));

    ctx.save();
    ctx.fillStyle='rgba(10,15,30,0.95)';
    ctx.strokeStyle='rgba(0,245,196,0.2)';ctx.lineWidth=1;
    ctx.beginPath();ctx.roundRect(tx,ty,tw,th,8);ctx.fill();ctx.stroke();

    ctx.fillStyle='#00f5c4';ctx.font='bold 11px Space Mono,monospace';
    ctx.fillText(n.label||'Hub',tx+pad,ty+pad+12);

    lines.forEach(([k,v],i)=>{
      const y=ty+pad+28+i*lh;
      ctx.fillStyle='rgba(100,116,139,0.9)';ctx.font='10px Space Mono,monospace';
      ctx.fillText(k,tx+pad,y);
      ctx.fillStyle='#e2e8f0';
      ctx.fillText(String(v),tx+pad+88,y);
    });
    ctx.restore();
  },

  getNodeAt(mx,my) {
    for(let i=this.nodes.length-1;i>=0;i--){
      const n=this.nodes[i];
      const r=n.type==='hub'?30:n.type==='provider'?22:18;
      const dx=n.x-mx,dy=n.y-my;
      if(dx*dx+dy*dy<=r*r) return n.id;
    }
    return null;
  },

  onMove(e) {
    const r=this.canvas.getBoundingClientRect();
    const mx=e.clientX-r.left, my=e.clientY-r.top;
    this.hoverId=this.getNodeAt(mx,my);
    this.canvas.style.cursor=this.hoverId?'pointer':'crosshair';
    if(this.dragging) {
      const n=this.nodes.find(n=>n.id===this.dragging);
      if(n){n.x=mx-this.dragOffX;n.y=my-this.dragOffY;}
    }
  },

  onDown(e) {
    const r=this.canvas.getBoundingClientRect();
    const mx=e.clientX-r.left, my=e.clientY-r.top;
    const id=this.getNodeAt(mx,my);
    if(id&&id!=='hub'){
      const n=this.nodes.find(n=>n.id===id);
      if(n){this.dragging=id;this.dragOffX=mx-n.x;this.dragOffY=my-n.y;}
    }
  },

  onUp() { this.dragging=null; },

  loop() {
    this.sync();
    this.tick();
    this.draw();
    requestAnimationFrame(()=>this.loop());
  }
};

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(btn){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('view-'+btn.dataset.tab)?.classList.add('active');
  btn.classList.add('active');
  if(btn.dataset.tab==='analytics')setTimeout(renderCharts,60);
}

// ── GPU catalog ───────────────────────────────────────────────────────────────
async function loadCatalog(){
  const data=await api('GET','/gpus');if(!data)return;
  gpuCatalog=data;workloads=data.workloads||[];
  const gpuSel=$i('p-gpu');
  if(gpuSel){
    gpuSel.innerHTML=data.gpus.map(g=>`<option value="${g.model}">${g.model}</option>`).join('');
    previewGpu(data.gpus[0]?.model);
  }
  const wlHtml=workloads.map(w=>`<option value="${w.type}">${w.icon||''} ${w.name}</option>`).join('');
  const cwl=$i('c-wl');if(cwl)cwl.innerHTML=wlHtml;
  const pre=$i('j-preset');
  if(pre)pre.innerHTML='<option value="">— Custom —</option>'
    +workloads.map(w=>`<option value="${w.name}">${w.icon||''} ${w.name}</option>`).join('');
  renderGpuTable(data.gpus);
}

function previewGpu(model){
  if(!gpuCatalog)return;
  const g=gpuCatalog.gpus.find(g=>g.model===model);if(!g)return;
  const el=$i('gpu-preview');if(!el)return;
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
  const el=$i('gpu-tbody');if(!el)return;
  el.innerHTML=gpus.map(g=>`<tr>
    <td><strong>${g.model}</strong><br><span style="color:var(--muted);font-size:10px">${g.architecture} · ${g.release_year}</span></td>
    <td><span class="tier ${g.tier}">${g.tier}</span></td>
    <td style="color:var(--accent)">${g.vram_gb}GB<br><span style="color:var(--muted);font-size:10px">${g.vram_type}</span></td>
    <td style="color:var(--accent)">${g.tflops_fp32}</td><td>${g.tflops_fp16}</td>
    <td>${g.memory_bandwidth_gbps}</td><td style="color:var(--accent3)">${g.tdp_watts}W</td>
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
  const sel=$i('j-client');if(!sel)return;
  sel.innerHTML='<option value="">— None —</option>'
    +(S.clients??[]).map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
}

// ── Actions ───────────────────────────────────────────────────────────────────
let pN=1,cN=1;
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
  if(!confirm('Reset entire network?'))return;
  ctrl('reset');
}
function clearLog(){ const el=$i('log-out');if(el)el.innerHTML=''; }
function exportLog(){
  const txt=(S.recent_events??[]).map(e=>`[${e.time}] [${e.level}] ${e.msg}`).join('\n');
  const a=document.createElement('a');
  a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(txt);
  a.download='neuralgrid_log.txt';a.click();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function $i(id)    { return document.getElementById(id); }
function txt(id,v) { const e=$i(id);if(e)e.textContent=v; }
function get(id)   { const e=$i(id);return e?e.value:''; }
function val(id,v) { const e=$i(id);if(e)e.value=v; }
function esc(s)    { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function graphDraw(){} // stub — actual draw is in GRAPH.loop's rAF

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  GRAPH.init();
  loadCatalog();
  connectWS();
  setInterval(refreshClientSel, 2000);
});
