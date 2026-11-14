# RCF MOUAU Library: your own AI, writing lecture notes on Kaggle's free GPU.
#
# HOW TO USE (once):
#   1. kaggle.com -> Create -> New Notebook
#   2. Right panel -> Session options: Accelerator = "GPU T4 x2", Internet = On
#   3. Add-ons -> Secrets -> Add secret:  label AI_WORKER_KEY, value = the same
#      key you put on Render (backend -> Environment -> AI_WORKER_KEY). Tick it.
#   4. Paste this whole file into the first cell and press Run (Shift+Enter).
#
# It installs Ollama, downloads the model (~9 GB, a few minutes the first time),
# then keeps asking your library for lecture-notes jobs and writes them until
# you stop the notebook or the session ends. The library makes the PDF, adds
# the RCF logo, publishes it and messages the person who asked.

import json, os, re, subprocess, sys, time

API = "https://rcf-library-backend.onrender.com/api/ai-worker"
MODEL = os.environ.get("NOTES_MODEL", "qwen3:14b")   # strong + fits one T4 GPU
RUN_HOURS = 11.5                                      # Kaggle stops sessions at 12h
IDLE_WAIT = 60                                        # seconds between checks when the queue is empty

def sh(cmd):
    print("$", cmd, flush=True)
    subprocess.run(cmd, shell=True, check=True)

# ---------- 1. Ollama + model ----------
try:
    import requests
except ImportError:
    sh(f"{sys.executable} -m pip install -q requests")
    import requests

if subprocess.run("which ollama", shell=True, capture_output=True).returncode != 0:
    sh("curl -fsSL https://ollama.com/install.sh | sh")

server = subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(60):
    try:
        requests.get("http://127.0.0.1:11434/api/tags", timeout=2)
        break
    except Exception:
        time.sleep(1)
sh(f"ollama pull {MODEL}")

# ---------- 2. Your library ----------
try:
    from kaggle_secrets import UserSecretsClient
    KEY = UserSecretsClient().get_secret("AI_WORKER_KEY")
except Exception:
    KEY = os.environ.get("AI_WORKER_KEY", "")
if not KEY:
    raise SystemExit("Add the AI_WORKER_KEY secret (Add-ons -> Secrets) and tick it for this notebook.")

def call(path, body, timeout=180):
    for attempt in range(5):
        try:
            r = requests.post(API + path, json=body, headers={"x-worker-key": KEY}, timeout=timeout)
            if r.status_code == 401:
                raise SystemExit("The library refused the key: AI_WORKER_KEY here and on Render must match exactly.")
            if r.status_code >= 500 or r.status_code == 429:
                raise RuntimeError(f"{r.status_code}: {r.text[:200]}")
            data = r.json()
            if r.status_code >= 400:
                raise RuntimeError(data.get("error") or r.text[:200])
            return data
        except SystemExit:
            raise
        except Exception as e:
            if attempt == 4:
                raise
            print(f"  library busy ({e}); retrying in 20s", flush=True)
            time.sleep(20)

def write(task):
    """Runs one step (plan / one week / revision) on the local model."""
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": task["system"]},
            {"role": "user", "content": task["prompt"]},
        ],
        "stream": False,
        "think": False,                       # straight to the notes, no hidden reasoning
        "options": {"num_ctx": 16384, "num_predict": min(int(task.get("maxTokens", 8000)), 8192), "temperature": 0.4},
    }
    r = requests.post("http://127.0.0.1:11434/api/chat", json=body, timeout=1800)
    r.raise_for_status()
    text = r.json().get("message", {}).get("content", "")
    return re.sub(r"<think>[\s\S]*?</think>", "", text).strip()

# ---------- 3. Work through the queue ----------
print(f"\n=== Your RCF notes AI is running ({MODEL}). Leave this tab open. ===\n", flush=True)
deadline = time.time() + RUN_HOURS * 3600
written = 0
while time.time() < deadline:
    try:
        job = call("/claim", {"model": MODEL}).get("job")
    except Exception as e:
        print("Could not reach the library:", e, flush=True)
        time.sleep(IDLE_WAIT)
        continue
    if not job:
        call("/heartbeat", {"model": MODEL})
        print(time.strftime("%H:%M"), "queue empty; waiting…", flush=True)
        time.sleep(IDLE_WAIT)
        continue

    job_id, task = job["jobId"], job["task"]
    print(f"\n>>> {job['title']}", flush=True)
    try:
        while task:
            label = f"week {task['week']}" if task["kind"] == "chapter" else task["kind"]
            started = time.time()
            text = ""
            for attempt in range(3):
                text = write(task)
                if len(text) > 200:
                    break
                print(f"  {label}: answer too short, trying again", flush=True)
            print(f"  {label}: {len(text.split())} words in {int(time.time() - started)}s", flush=True)
            res = call(f"/jobs/{job_id}/answer", {"kind": task["kind"], "week": task.get("week"), "text": text, "model": MODEL})
            if res.get("done"):
                written += 1
                print(f"  ✅ Published: {res.get('title')}  (total this session: {written})", flush=True)
                break
            task = res.get("next")
    except SystemExit:
        raise
    except Exception as e:
        print("  Problem with this job, handing it back:", e, flush=True)
        try:
            call(f"/jobs/{job_id}/release", {"error": str(e)[:200]})
        except Exception:
            pass
        time.sleep(30)

print(f"\nSession finished. Notes packs written: {written}. Run the cell again to continue.", flush=True)
