"""
NeuralGrid — FastAPI Backend v4
Fixes: resilient sim loop that survives Render free tier spin-down,
       proper asyncio task supervision, correct static file serving.
"""
import asyncio, json, os, random, uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="NeuralGrid", version="4.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── GPU data ──────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).parent
GPU_FILE   = BASE_DIR / "gpus.json"
FRONT_DIR  = BASE_DIR.parent / "frontend"

with open(GPU_FILE, encoding="utf-8") as f:
    GPU_DATA = json.load(f)
GPU_CATALOG  = {g["model"]: g for g in GPU_DATA["gpus"]}
WORKLOAD_LIST = GPU_DATA["workloads"]

# ── State ─────────────────────────────────────────────────────────────────────
class SimState:
    def __init__(self):
        self.nodes:  dict = {}
        self.clients:dict = {}
        self.jobs:   dict = {}
        self.tick:   int  = 0
        self.running:bool = False
        self.speed:  float= 1.0
        self.events: list = []
        self.util_history:       list = []
        self.throughput_history: list = []
        self.bw_history:         list = []
        self.completed_count: int   = 0
        self.failed_count:    int   = 0
        self.total_earnings:  float = 0.0

    def log(self, msg: str, level: str = "info"):
        self.events.insert(0, {
            "time":  datetime.now().strftime("%H:%M:%S"),
            "msg":   msg,
            "level": level,
            "tick":  self.tick,
        })
        if len(self.events) > 300:
            self.events.pop()

    def snapshot(self) -> dict:
        nl   = list(self.nodes.values())
        busy = [n for n in nl if n["status"] == "busy"]
        return {
            "tick":    self.tick,
            "running": self.running,
            "speed":   self.speed,
            "nodes":   nl,
            "clients": list(self.clients.values()),
            "jobs":    list(self.jobs.values()),
            "stats": {
                "total_nodes":      len(nl),
                "busy_nodes":       len(busy),
                "idle_nodes":       sum(1 for n in nl if n["status"] == "idle"),
                "offline_nodes":    sum(1 for n in nl if n["status"] == "offline"),
                "total_clients":    len(self.clients),
                "total_tflops":     sum(n["tflops"] for n in nl),
                "utilized_tflops":  sum(n["tflops"] for n in busy),
                "util_pct":         round(len(busy) / max(len(nl), 1) * 100, 1),
                "completed":        self.completed_count,
                "failed":           self.failed_count,
                "running_jobs":     sum(1 for j in self.jobs.values() if j["status"] == "running"),
                "queued_jobs":      sum(1 for j in self.jobs.values() if j["status"] == "queued"),
                "total_earnings":   round(self.total_earnings, 4),
            },
            "util_history":       self.util_history[-40:],
            "throughput_history": self.throughput_history[-40:],
            "bw_history":         self.bw_history[-40:],
            "recent_events":      self.events[:30],
        }

sim = SimState()

# ── WebSocket manager ─────────────────────────────────────────────────────────
class WSManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        self.active = [c for c in self.active if c is not ws]

    async def broadcast(self, payload: dict):
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.active = [c for c in self.active if c is not ws]

ws_mgr = WSManager()

# ── Simulation logic ──────────────────────────────────────────────────────────
def dispatch_jobs():
    prio = {"critical": 0, "high": 1, "normal": 2, "low": 3}
    queued = sorted(
        [j for j in sim.jobs.values() if j["status"] == "queued"],
        key=lambda j: prio.get(j["priority"], 2),
    )
    for job in queued:
        candidates = [
            n for n in sim.nodes.values()
            if n["status"] == "idle"
            and n["vram"]   >= job["vram_req"]
            and n["tflops"] >= job["tflops_req"] * 0.4
        ]
        if not candidates:
            continue
        node = min(candidates, key=lambda n: abs(n["vram"] - job["vram_req"]))
        gpu  = GPU_CATALOG.get(node["gpu_model"], {})
        rate = gpu.get("rental_per_hour_usd", 0.10)
        job.update({
            "status":         "running",
            "assigned_node":  node["id"],
            "started_at":     sim.tick,
            "estimated_cost": round(rate * job["duration_ticks"] / 60, 4),
        })
        node.update({
            "status":      "busy",
            "current_job": job["id"],
            "jobs_run":    node["jobs_run"] + 1,
        })
        if job.get("client_id") and job["client_id"] in sim.clients:
            sim.clients[job["client_id"]].update({
                "assigned_node": node["id"],
                "status": "active",
            })
        sim.log(f'{job["id"]} → {node["name"]} [{node["gpu_model"]}]', "success")


def do_tick():
    sim.tick += 1

    # Progress running jobs
    for job in list(sim.jobs.values()):
        if job["status"] != "running":
            continue
        job["ticks_left"] -= 1
        job["progress"]    = round(
            (job["duration_ticks"] - job["ticks_left"])
            / max(job["duration_ticks"], 1) * 100
        )
        if job["ticks_left"] <= 0:
            job.update({"status": "completed", "progress": 100, "completed_at": sim.tick})
            sim.completed_count += 1
            node = sim.nodes.get(job["assigned_node"])
            if node:
                gpu  = GPU_CATALOG.get(node["gpu_model"], {})
                earn = round(gpu.get("salad_rate_per_hour", 0.05) * job["duration_ticks"] / 60, 4)
                node.update({
                    "status":          "idle",
                    "current_job":     None,
                    "jobs_completed":  node["jobs_completed"] + 1,
                    "earnings":        round(node["earnings"] + earn, 4),
                })
                sim.total_earnings = round(sim.total_earnings + earn, 4)
            if job.get("client_id") and job["client_id"] in sim.clients:
                sim.clients[job["client_id"]].update({"assigned_node": None, "status": "waiting"})
            sim.log(f'{job["id"]} COMPLETED [${job.get("estimated_cost",0):.4f}]', "success")

    # Node faults
    for node in list(sim.nodes.values()):
        if node["status"] == "idle" and random.random() < 0.015:
            node["status"]       = "offline"
            node["offline_until"] = sim.tick + random.randint(2, 6)
            sim.log(f'Node {node["name"]} went OFFLINE', "error")

    # Node recovery
    for node in list(sim.nodes.values()):
        if node["status"] == "offline" and sim.tick >= node.get("offline_until", 0):
            node["status"] = "idle"
            sim.log(f'Node {node["name"]} back ONLINE', "info")

    dispatch_jobs()

    # History
    nl   = list(sim.nodes.values())
    busy = sum(1 for n in nl if n["status"] == "busy")
    sim.util_history.append(round(busy / max(len(nl), 1) * 100, 1))
    sim.throughput_history.append(sim.completed_count)
    sim.bw_history.append(sum(n["bandwidth_gbps"] for n in nl if n["status"] == "busy"))
    for h in (sim.util_history, sim.throughput_history, sim.bw_history):
        if len(h) > 60:
            h.pop(0)


# ── Supervised sim loop ───────────────────────────────────────────────────────
# Wraps the loop in a supervisor so if it ever crashes it restarts automatically.
async def _sim_loop():
    while True:
        try:
            if sim.running and sim.nodes:
                do_tick()
                snap = {"type": "snapshot", "data": sim.snapshot()}
                await ws_mgr.broadcast(snap)
            interval = 1.0 / max(sim.speed, 0.1)
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            sim.log(f"Sim loop error: {e}", "error")
            await asyncio.sleep(1.0)


async def _supervisor():
    """Restart the sim loop task if it ever dies."""
    while True:
        task = asyncio.create_task(_sim_loop())
        try:
            await task
        except asyncio.CancelledError:
            break
        except Exception as e:
            sim.log(f"Supervisor restarting sim loop after: {e}", "error")
            await asyncio.sleep(1.0)


@app.on_event("startup")
async def on_startup():
    asyncio.create_task(_supervisor())
    sim.log("NeuralGrid v4 started ✓", "info")


# ── Request models ────────────────────────────────────────────────────────────
class NodeReq(BaseModel):
    name: str
    gpu_model: str
    bandwidth_gbps: float = 10.0
    location: str = "Unknown"

class ClientReq(BaseModel):
    name: str
    workload_type: str
    vram_req: int
    priority: str = "normal"

class JobReq(BaseModel):
    name: str
    job_type: str
    vram_req: int
    tflops_req: int
    duration_ticks: int
    priority: str = "normal"
    client_id: Optional[str] = None

class CtrlReq(BaseModel):
    action: str
    value: Optional[float] = None


# ── API routes ────────────────────────────────────────────────────────────────
@app.get("/api/gpus")
def r_gpus():
    return GPU_DATA

@app.get("/api/state")
def r_state():
    return sim.snapshot()

@app.get("/api/logs")
def r_logs():
    return sim.events

# Nodes
@app.post("/api/nodes", status_code=201)
def r_add_node(req: NodeReq):
    if req.gpu_model not in GPU_CATALOG:
        raise HTTPException(400, f"Unknown GPU: {req.gpu_model}")
    gpu = GPU_CATALOG[req.gpu_model]
    nid = "node_" + uuid.uuid4().hex[:8]
    node = {
        "id": nid, "name": req.name, "gpu_model": req.gpu_model,
        "vram": gpu["vram_gb"], "tflops": gpu["tflops_fp32"],
        "tflops_fp16": gpu["tflops_fp16"],
        "bandwidth_gbps": req.bandwidth_gbps,
        "tdp_watts": gpu["tdp_watts"],
        "market_price": gpu["market_price_usd"],
        "salad_rate":   gpu["salad_rate_per_hour"],
        "vastai_rate":  gpu["vastai_rate_per_hour"],
        "tier": gpu["tier"], "location": req.location,
        "status": "idle", "current_job": None,
        "jobs_run": 0, "jobs_completed": 0,
        "earnings": 0.0, "offline_until": 0, "joined_at": sim.tick,
    }
    sim.nodes[nid] = node
    sim.log(f'Provider "{req.name}" joined [{req.gpu_model} · {gpu["vram_gb"]}GB]', "success")
    return node

@app.delete("/api/nodes/{node_id}")
def r_del_node(node_id: str):
    if node_id not in sim.nodes:
        raise HTTPException(404, "Node not found")
    n = sim.nodes.pop(node_id)
    sim.log(f'Node "{n["name"]}" removed', "warn")
    return {"ok": True}

# Clients
@app.post("/api/clients", status_code=201)
def r_add_client(req: ClientReq):
    cid = "client_" + uuid.uuid4().hex[:8]
    client = {
        "id": cid, "name": req.name,
        "workload_type": req.workload_type,
        "vram_req": req.vram_req, "priority": req.priority,
        "status": "waiting", "assigned_node": None,
        "jobs_submitted": 0, "joined_at": sim.tick,
    }
    sim.clients[cid] = client
    sim.log(f'Client "{req.name}" connected [{req.workload_type}]', "info")
    return client

@app.delete("/api/clients/{client_id}")
def r_del_client(client_id: str):
    if client_id not in sim.clients:
        raise HTTPException(404, "Client not found")
    sim.clients.pop(client_id)
    return {"ok": True}

# Jobs
@app.post("/api/jobs", status_code=201)
def r_submit_job(req: JobReq):
    jid = f"JOB_{sim.tick:04d}_{uuid.uuid4().hex[:4].upper()}"
    job = {
        "id": jid, "name": req.name, "job_type": req.job_type,
        "vram_req": req.vram_req, "tflops_req": req.tflops_req,
        "duration_ticks": req.duration_ticks, "priority": req.priority,
        "client_id": req.client_id,
        "status": "queued", "progress": 0,
        "ticks_left": req.duration_ticks,
        "assigned_node": None,
        "queued_at": sim.tick, "started_at": None,
        "completed_at": None, "estimated_cost": 0.0,
    }
    sim.jobs[jid] = job
    if req.client_id and req.client_id in sim.clients:
        sim.clients[req.client_id]["jobs_submitted"] += 1
    dispatch_jobs()
    sim.log(f'Job "{jid}" queued [{req.job_type} · {req.vram_req}GB · {req.priority}]', "warn")
    return job

@app.post("/api/jobs/random")
def r_random_jobs():
    clients = list(sim.clients.keys())
    created = []
    for _ in range(5):
        wl  = random.choice(WORKLOAD_LIST)
        dur = max(3, wl["avg_duration_ticks"] + random.randint(-2, 5))
        req = JobReq(
            name       = f'{wl["name"]} #{random.randint(1,99)}',
            job_type   = wl["type"],
            vram_req   = wl["min_vram_gb"],
            tflops_req = wl["tflops_required"],
            duration_ticks = dur,
            priority   = random.choice(["critical","high","normal","normal","low"]),
            client_id  = random.choice(clients) if clients else None,
        )
        created.append(r_submit_job(req))
    return created

@app.delete("/api/jobs/completed")
def r_clear_done():
    before = len(sim.jobs)
    sim.jobs = {k: v for k, v in sim.jobs.items() if v["status"] != "completed"}
    return {"cleared": before - len(sim.jobs)}

# Sim control
@app.post("/api/sim/control")
def r_control(req: CtrlReq):
    if req.action == "start":
        sim.running = True
        sim.log("Simulation STARTED ▶", "info")
    elif req.action == "stop":
        sim.running = False
        sim.log("Simulation PAUSED ⏸", "warn")
    elif req.action == "step":
        do_tick()
        sim.log(f"Manual step → tick #{sim.tick}", "info")
    elif req.action == "speed":
        sim.speed = max(0.1, min(float(req.value or 1.0), 20.0))
        sim.log(f"Speed → {sim.speed}×", "info")
    elif req.action == "reset":
        sim.nodes.clear(); sim.clients.clear(); sim.jobs.clear()
        sim.tick = 0; sim.running = False; sim.speed = 1.0
        sim.events.clear()
        sim.util_history.clear(); sim.throughput_history.clear(); sim.bw_history.clear()
        sim.completed_count = 0; sim.failed_count = 0; sim.total_earnings = 0.0
        sim.log("Network RESET ↺", "warn")
    return sim.snapshot()

# WebSocket
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws_mgr.connect(ws)
    try:
        await ws.send_json({"type": "snapshot", "data": sim.snapshot()})
        while True:
            msg = await ws.receive_text()
            if msg == "ping":
                await ws.send_text("pong")
    except WebSocketDisconnect:
        ws_mgr.disconnect(ws)

# ── Serve frontend ────────────────────────────────────────────────────────────
if FRONT_DIR.exists():
    # Serve /static/... for all frontend assets
    app.mount("/static", StaticFiles(directory=str(FRONT_DIR)), name="static")

    @app.get("/")
    def serve_root():
        return FileResponse(str(FRONT_DIR / "index.html"))

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        p = FRONT_DIR / full_path
        if p.exists() and p.is_file():
            return FileResponse(str(p))
        return FileResponse(str(FRONT_DIR / "index.html"))

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
