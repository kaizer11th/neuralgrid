"""
NeuralGrid — FastAPI Backend
Serves the frontend + REST API + WebSocket real-time simulation.
Deploy on Render.com: this single process does everything.
"""

import asyncio
import json
import os
import random
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ── App ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="NeuralGrid API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── GPU Data ──────────────────────────────────────────────────────────────────
BASE = Path(__file__).parent
DATA_FILE = BASE / "gpus.json"

with open(DATA_FILE, encoding='utf-8') as f:
    GPU_DATA = json.load(f)

GPU_CATALOG = {g["model"]: g for g in GPU_DATA["gpus"]}
WORKLOAD_LIST = GPU_DATA["workloads"]

# ── Simulation State ──────────────────────────────────────────────────────────
class SimState:
    def __init__(self):
        self.nodes: dict = {}
        self.clients: dict = {}
        self.jobs: dict = {}
        self.tick: int = 0
        self.running: bool = False
        self.speed: float = 1.0
        self.events: list = []
        self.util_history: list = []
        self.throughput_history: list = []
        self.bw_history: list = []
        self.completed_count: int = 0
        self.failed_count: int = 0
        self.total_earnings: float = 0.0

    def log(self, msg: str, level: str = "info"):
        entry = {
            "time": datetime.now().strftime("%H:%M:%S"),
            "msg": msg,
            "level": level,
            "tick": self.tick,
        }
        self.events.insert(0, entry)
        if len(self.events) > 500:
            self.events.pop()

    def snapshot(self) -> dict:
        nodes_list = list(self.nodes.values())
        busy = [n for n in nodes_list if n["status"] == "busy"]
        total_t = sum(n["tflops"] for n in nodes_list)
        util_pct = round(len(busy) / max(len(nodes_list), 1) * 100, 1)
        return {
            "tick": self.tick,
            "running": self.running,
            "speed": self.speed,
            "nodes": nodes_list,
            "clients": list(self.clients.values()),
            "jobs": list(self.jobs.values()),
            "stats": {
                "total_nodes": len(nodes_list),
                "busy_nodes": len(busy),
                "idle_nodes": sum(1 for n in nodes_list if n["status"] == "idle"),
                "offline_nodes": sum(1 for n in nodes_list if n["status"] == "offline"),
                "total_clients": len(self.clients),
                "total_tflops": total_t,
                "utilized_tflops": sum(n["tflops"] for n in busy),
                "util_pct": util_pct,
                "completed": self.completed_count,
                "failed": self.failed_count,
                "running_jobs": sum(1 for j in self.jobs.values() if j["status"] == "running"),
                "queued_jobs": sum(1 for j in self.jobs.values() if j["status"] == "queued"),
                "total_earnings": round(self.total_earnings, 4),
            },
            "util_history": self.util_history[-40:],
            "throughput_history": self.throughput_history[-40:],
            "bw_history": self.bw_history[-40:],
            "recent_events": self.events[:30],
        }


sim = SimState()


# ── WebSocket Manager ─────────────────────────────────────────────────────────
class WSManager:
    def __init__(self):
        self.connections: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.connections.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.connections:
            self.connections.remove(ws)

    async def broadcast(self, payload: dict):
        dead = []
        for ws in self.connections:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.connections.remove(ws)


ws_manager = WSManager()


# ── Simulation Logic ──────────────────────────────────────────────────────────
def dispatch_jobs():
    """Priority-based best-fit scheduling."""
    priority_order = {"critical": 0, "high": 1, "normal": 2, "low": 3}
    queued = sorted(
        [j for j in sim.jobs.values() if j["status"] == "queued"],
        key=lambda j: priority_order.get(j["priority"], 2),
    )
    for job in queued:
        candidates = [
            n for n in sim.nodes.values()
            if n["status"] == "idle"
            and n["vram"] >= job["vram_req"]
            and n["tflops"] >= job["tflops_req"] * 0.4
        ]
        if not candidates:
            continue
        # Best-fit: node whose VRAM is closest to requirement (avoid wasting big nodes)
        node = min(candidates, key=lambda n: abs(n["vram"] - job["vram_req"]))
        gpu_info = GPU_CATALOG.get(node["gpu_model"], {})
        rate = gpu_info.get("rental_per_hour_usd", 0.10)
        job.update({
            "status": "running",
            "assigned_node": node["id"],
            "started_at": sim.tick,
            "estimated_cost": round(rate * (job["duration_ticks"] / 60), 4),
        })
        node.update({
            "status": "busy",
            "current_job": job["id"],
            "jobs_run": node["jobs_run"] + 1,
        })
        if job.get("client_id") and job["client_id"] in sim.clients:
            sim.clients[job["client_id"]].update({
                "assigned_node": node["id"],
                "status": "active",
            })
        sim.log(
            f'{job["id"]} → {node["name"]} [{node["gpu_model"]}] dispatched',
            "success",
        )


def tick():
    """Advance simulation by one step."""
    sim.tick += 1

    # Progress running jobs
    for job in list(sim.jobs.values()):
        if job["status"] != "running":
            continue
        job["ticks_left"] -= 1
        job["progress"] = round(
            (job["duration_ticks"] - job["ticks_left"]) / job["duration_ticks"] * 100
        )
        if job["ticks_left"] <= 0:
            job.update({"status": "completed", "progress": 100, "completed_at": sim.tick})
            sim.completed_count += 1
            node = sim.nodes.get(job["assigned_node"])
            if node:
                gpu_info = GPU_CATALOG.get(node["gpu_model"], {})
                earn = round(
                    gpu_info.get("salad_rate_per_hour", 0.05) * (job["duration_ticks"] / 60), 4
                )
                node.update({
                    "status": "idle",
                    "current_job": None,
                    "jobs_completed": node["jobs_completed"] + 1,
                    "earnings": round(node["earnings"] + earn, 4),
                })
                sim.total_earnings = round(sim.total_earnings + earn, 4)
            if job.get("client_id") and job["client_id"] in sim.clients:
                sim.clients[job["client_id"]].update({
                    "assigned_node": None,
                    "status": "waiting",
                })
            sim.log(
                f'{job["id"]} COMPLETED on {node["name"] if node else "?"}'
                f' [${job.get("estimated_cost", 0):.4f}]',
                "success",
            )

    # Random node faults (1.5% chance per idle node per tick)
    for node in sim.nodes.values():
        if node["status"] == "idle" and random.random() < 0.015:
            node["status"] = "offline"
            node["offline_until"] = sim.tick + random.randint(2, 6)
            sim.log(f'Node {node["name"]} went OFFLINE (network fault)', "error")

    # Recover offline nodes
    for node in sim.nodes.values():
        if node["status"] == "offline" and sim.tick >= node.get("offline_until", 0):
            node["status"] = "idle"
            sim.log(f'Node {node["name"]} recovered — back ONLINE', "info")

    dispatch_jobs()

    # Record history
    nodes_list = list(sim.nodes.values())
    busy_count = sum(1 for n in nodes_list if n["status"] == "busy")
    util = round(busy_count / max(len(nodes_list), 1) * 100, 1)
    sim.util_history.append(util)
    sim.throughput_history.append(sim.completed_count)
    sim.bw_history.append(
        sum(n["bandwidth_gbps"] for n in nodes_list if n["status"] == "busy")
    )
    for h in (sim.util_history, sim.throughput_history, sim.bw_history):
        if len(h) > 60:
            h.pop(0)


async def sim_loop():
    """Background loop that ticks the simulation and broadcasts snapshots."""
    while True:
        if sim.running and sim.nodes:
            tick()
            await ws_manager.broadcast({"type": "snapshot", "data": sim.snapshot()})
        await asyncio.sleep(1.0 / max(sim.speed, 0.1))


@app.on_event("startup")
async def on_startup():
    asyncio.create_task(sim_loop())
    sim.log("NeuralGrid backend started. Add nodes to begin.", "info")


# ── Request Models ────────────────────────────────────────────────────────────
class NodeRequest(BaseModel):
    name: str
    gpu_model: str
    bandwidth_gbps: float = 10.0
    location: str = "Unknown"


class ClientRequest(BaseModel):
    name: str
    workload_type: str
    vram_req: int
    priority: str = "normal"


class JobRequest(BaseModel):
    name: str
    job_type: str
    vram_req: int
    tflops_req: int
    duration_ticks: int
    priority: str = "normal"
    client_id: Optional[str] = None


class ControlRequest(BaseModel):
    action: str          # start | stop | step | speed | reset
    value: Optional[float] = None


# ── REST Routes ───────────────────────────────────────────────────────────────
@app.get("/api/gpus")
def api_gpus():
    return GPU_DATA


@app.get("/api/state")
def api_state():
    return sim.snapshot()


@app.get("/api/logs")
def api_logs():
    return sim.events


# Nodes
@app.post("/api/nodes", status_code=201)
def api_add_node(req: NodeRequest):
    if req.gpu_model not in GPU_CATALOG:
        raise HTTPException(400, f"Unknown GPU model: {req.gpu_model}")
    gpu = GPU_CATALOG[req.gpu_model]
    nid = "node_" + uuid.uuid4().hex[:8]
    node = {
        "id": nid,
        "name": req.name,
        "gpu_model": req.gpu_model,
        "vram": gpu["vram_gb"],
        "tflops": gpu["tflops_fp32"],
        "tflops_fp16": gpu["tflops_fp16"],
        "bandwidth_gbps": req.bandwidth_gbps,
        "tdp_watts": gpu["tdp_watts"],
        "market_price": gpu["market_price_usd"],
        "salad_rate": gpu["salad_rate_per_hour"],
        "vastai_rate": gpu["vastai_rate_per_hour"],
        "tier": gpu["tier"],
        "location": req.location,
        "status": "idle",
        "current_job": None,
        "jobs_run": 0,
        "jobs_completed": 0,
        "earnings": 0.0,
        "offline_until": 0,
        "joined_at": sim.tick,
    }
    sim.nodes[nid] = node
    sim.log(
        f'Provider "{req.name}" joined [{req.gpu_model} · {gpu["vram_gb"]}GB · {gpu["tflops_fp32"]}T FP32]',
        "success",
    )
    return node


@app.delete("/api/nodes/{node_id}")
def api_delete_node(node_id: str):
    if node_id not in sim.nodes:
        raise HTTPException(404, "Node not found")
    n = sim.nodes.pop(node_id)
    sim.log(f'Node "{n["name"]}" removed from network', "warn")
    return {"ok": True}


# Clients
@app.post("/api/clients", status_code=201)
def api_add_client(req: ClientRequest):
    cid = "client_" + uuid.uuid4().hex[:8]
    client = {
        "id": cid,
        "name": req.name,
        "workload_type": req.workload_type,
        "vram_req": req.vram_req,
        "priority": req.priority,
        "status": "waiting",
        "assigned_node": None,
        "jobs_submitted": 0,
        "joined_at": sim.tick,
    }
    sim.clients[cid] = client
    sim.log(
        f'Client "{req.name}" connected [{req.workload_type} · {req.vram_req}GB]',
        "info",
    )
    return client


@app.delete("/api/clients/{client_id}")
def api_delete_client(client_id: str):
    if client_id not in sim.clients:
        raise HTTPException(404, "Client not found")
    sim.clients.pop(client_id)
    return {"ok": True}


# Jobs
@app.post("/api/jobs", status_code=201)
def api_submit_job(req: JobRequest):
    jid = f"JOB_{sim.tick:04d}_{uuid.uuid4().hex[:4].upper()}"
    job = {
        "id": jid,
        "name": req.name,
        "job_type": req.job_type,
        "vram_req": req.vram_req,
        "tflops_req": req.tflops_req,
        "duration_ticks": req.duration_ticks,
        "priority": req.priority,
        "client_id": req.client_id,
        "status": "queued",
        "progress": 0,
        "ticks_left": req.duration_ticks,
        "assigned_node": None,
        "queued_at": sim.tick,
        "started_at": None,
        "completed_at": None,
        "estimated_cost": 0.0,
    }
    sim.jobs[jid] = job
    if req.client_id and req.client_id in sim.clients:
        sim.clients[req.client_id]["jobs_submitted"] += 1
    dispatch_jobs()
    sim.log(
        f'Job "{jid}" queued [{req.job_type} · {req.vram_req}GB · {req.priority}]',
        "warn",
    )
    return job


@app.post("/api/jobs/random")
def api_random_jobs():
    clients = list(sim.clients.keys())
    created = []
    for _ in range(5):
        wl = random.choice(WORKLOAD_LIST)
        dur = max(2, wl["avg_duration_ticks"] + random.randint(-2, 5))
        req = JobRequest(
            name=f'{wl["name"]} #{random.randint(1, 99)}',
            job_type=wl["type"],
            vram_req=wl["min_vram_gb"],
            tflops_req=wl["tflops_required"],
            duration_ticks=dur,
            priority=random.choice(["critical", "high", "normal", "normal", "low"]),
            client_id=random.choice(clients) if clients else None,
        )
        created.append(api_submit_job(req))
    return created


@app.delete("/api/jobs/completed")
def api_clear_completed():
    before = len(sim.jobs)
    sim.jobs = {k: v for k, v in sim.jobs.items() if v["status"] != "completed"}
    return {"cleared": before - len(sim.jobs)}


# Simulation control
@app.post("/api/sim/control")
def api_sim_control(req: ControlRequest):
    if req.action == "start":
        sim.running = True
        sim.log("Simulation STARTED", "info")
    elif req.action == "stop":
        sim.running = False
        sim.log("Simulation PAUSED", "warn")
    elif req.action == "step":
        tick()
        sim.log(f"Manual step → tick #{sim.tick}", "info")
    elif req.action == "speed":
        sim.speed = max(0.1, min(float(req.value or 1.0), 20.0))
        sim.log(f"Speed set to {sim.speed}×", "info")
    elif req.action == "reset":
        sim.nodes.clear()
        sim.clients.clear()
        sim.jobs.clear()
        sim.tick = 0
        sim.running = False
        sim.speed = 1.0
        sim.events.clear()
        sim.util_history.clear()
        sim.throughput_history.clear()
        sim.bw_history.clear()
        sim.completed_count = 0
        sim.failed_count = 0
        sim.total_earnings = 0.0
        sim.log("Network RESET — all nodes and jobs cleared", "warn")
    return sim.snapshot()


# ── WebSocket ─────────────────────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws_manager.connect(ws)
    try:
        # Send full state immediately on connect
        await ws.send_json({"type": "snapshot", "data": sim.snapshot()})
        while True:
            msg = await ws.receive_text()
            if msg == "ping":
                await ws.send_text("pong")
    except WebSocketDisconnect:
        ws_manager.disconnect(ws)


# ── Serve Frontend ─────────────────────────────────────────────────────────────
# The frontend folder lives at ../frontend relative to this file.
# FastAPI mounts it and serves index.html at the root.
FRONTEND = BASE.parent / "frontend"

if FRONTEND.exists():
    # Mount /static for css/js/data
    app.mount("/static", StaticFiles(directory=str(FRONTEND)), name="frontend_static")

    @app.get("/")
    def serve_index():
        return FileResponse(str(FRONTEND / "index.html"))

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        """Catch-all: serve index.html for any unknown path (SPA support)."""
        file = FRONTEND / full_path
        if file.exists() and file.is_file():
            return FileResponse(str(file))
        return FileResponse(str(FRONTEND / "index.html"))


# ── Entry Point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
