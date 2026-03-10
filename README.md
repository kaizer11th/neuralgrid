# ⬡ NeuralGrid — Distributed GPU Network Simulator

> FastAPI Python backend · WebSocket real-time simulation · D3.js force graph · Real GPU market data

---

## How it works

```
Browser  ←──── WebSocket (live snapshots every tick) ────►  FastAPI (Render)
         ←──── REST API (add nodes, submit jobs, etc.) ───►  Python sim engine
                                                              gpus.json (real data)
```

- The **backend** (Python/FastAPI) runs on Render. It does the simulation, serves the frontend files, and streams state to all connected browsers via WebSocket.
- The **frontend** is plain HTML/CSS/JS with D3.js. It is served by the same FastAPI process (no separate hosting needed).
- There is **no demo mode** — everything talks to the real backend.

---

## Step 1 — Test locally

### Requirements
- Python 3.11+
- Git

### Run
```bash
# Clone your repo (or just cd into the project folder)
cd neuralgrid

# Create and activate a virtual environment
python -m venv venv
source venv/bin/activate        # Mac/Linux
# venv\Scripts\activate         # Windows

# Install Python dependencies
pip install -r backend/requirements.txt

# Start the server
cd backend
python main.py
```

Open **http://localhost:8000** — you should see NeuralGrid.

> The backend auto-serves the `frontend/` folder.
> Add some GPU nodes, add a client, submit jobs, hit Start Sim.

---

## Step 2 — Push to GitHub

```bash
# From the neuralgrid/ root folder:
git init
git add .
git commit -m "NeuralGrid GPU simulator"
git branch -M main

# Create a new repo on github.com first, then:
git remote add origin https://github.com/YOUR_USERNAME/neuralgrid.git
git push -u origin main
```

---

## Step 3 — Deploy backend on Render

1. Go to **https://render.com** and sign in (free tier is fine)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repo
4. Fill in the settings:

| Setting | Value |
|---|---|
| **Name** | `neuralgrid` |
| **Root Directory** | `backend` |
| **Runtime** | `Python 3` |
| **Build Command** | `pip install -r requirements.txt` |
| **Start Command** | `uvicorn main:app --host 0.0.0.0 --port $PORT` |
| **Instance Type** | Free |

5. Click **"Create Web Service"**
6. Wait ~2 minutes for the first deploy
7. Copy your URL — it looks like `https://neuralgrid-xxxx.onrender.com`

> **Test it:** visit `https://neuralgrid-xxxx.onrender.com` — you should see the live NeuralGrid interface directly from Render.

---

## Step 4 — (Optional) GitHub Pages pointing at Render

If you want a nicer URL like `yourusername.github.io/neuralgrid`, you can have GitHub Pages serve the frontend while it talks to the Render backend.

### 4a. Update the backend URL in index.html

Open `frontend/index.html` and find line ~17:

```html
<script>
  const BACKEND_URL = "";   // ← REPLACE with your Render URL after deploy
</script>
```

Change it to:

```html
<script>
  const BACKEND_URL = "https://neuralgrid-xxxx.onrender.com";
</script>
```

### 4b. Enable GitHub Pages

1. Go to your repo → **Settings** → **Pages**
2. Source: **Deploy from branch**
3. Branch: `main`, Folder: `/frontend`
4. Save

Your site will be live at `https://YOUR_USERNAME.github.io/neuralgrid/`

### 4c. Push the change
```bash
git add frontend/index.html
git commit -m "Point frontend at Render backend"
git push
```

GitHub Pages updates in ~1 minute.

---

## File structure

```
neuralgrid/
├── backend/
│   ├── main.py           ← FastAPI app + simulation engine + WebSocket
│   ├── gpus.json         ← Real GPU catalog (Vast.ai/Salad pricing)
│   └── requirements.txt  ← Python deps
├── frontend/
│   ├── index.html        ← Main page (served by FastAPI or GitHub Pages)
│   ├── css/style.css     ← Styles
│   ├── js/app.js         ← D3 graph, REST calls, WebSocket client
│   └── data/gpus.json    ← GPU catalog copy (for static serving)
├── render.yaml           ← Render deploy config
└── README.md
```

---

## API reference

| Method | Endpoint | What it does |
|---|---|---|
| GET | `/api/gpus` | Real GPU catalog with specs & pricing |
| GET | `/api/state` | Full sim snapshot (nodes, jobs, stats, history) |
| POST | `/api/nodes` | Add a GPU provider node |
| DELETE | `/api/nodes/{id}` | Remove a node |
| POST | `/api/clients` | Add a client |
| DELETE | `/api/clients/{id}` | Remove a client |
| POST | `/api/jobs` | Submit a job |
| POST | `/api/jobs/random` | Submit 5 random jobs |
| DELETE | `/api/jobs/completed` | Clear completed jobs |
| POST | `/api/sim/control` | `{action: "start"\|"stop"\|"step"\|"speed"\|"reset"}` |
| GET | `/api/logs` | Recent event log |
| WS | `/ws` | Real-time snapshot stream |

---

## GPU data sources

All rental prices are from **Vast.ai** and **Salad.com** public marketplaces (2025-Q1 averages).
GPU specs are from **TechPowerUp GPU Database**.
Market prices are retail (NewEgg/B&H, 2025).

| GPU | Vast.ai/hr | Salad/hr |
|---|---|---|
| H100 SXM5 80GB | $2.49 | $1.85 |
| A100 80GB | $1.89 | $1.20 |
| RTX 4090 | $0.74 | $0.22 |
| RTX 4080 Super | $0.44 | $0.14 |
| RTX 3090 Ti | $0.42 | $0.17 |
| RTX A6000 | $0.79 | $0.35 |
