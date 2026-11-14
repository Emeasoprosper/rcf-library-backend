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
print("Starting the RCF notes AI… (step 1 of 3: installing)", flush=True)

API ="https://rcf-library-backend.onrender.com/api/ai-worker"
MODEL = os.environ.get("NOTES_MODEL", "qwen3:14b")   # strong + fits one T4 GPU
RUN_HOURS = 11.7                                      # Kaggle kills a session at exactly 12h
JOB_MINUTES = 80                                      # one course takes ~70 min on a T4
IDLE_WAIT = 60                                        # seconds between checks when the queue is empty

def sh(cmd):
    """Runs a shell command and shows its output here (Kaggle hides it otherwise)."""
    print("$", cmd, flush=True)
    p = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in p.stdout:
        line = line.strip()
        if line:
            print("  ", line[-160:], flush=True)
    if p.wait() != 0:
        raise SystemExit(f"Command failed: {cmd}")

# ---------- 1. Ollama + model ----------
try:
    import requests
except ImportError:
    sh(f"{sys.executable} -m pip install -q requests")
    import requests

if subprocess.run("which ollama", shell=True, capture_output=True).returncode != 0:
    # Ollama's installer unpacks with zstd, which Kaggle's machine lacks.
    if subprocess.run("which zstd", shell=True, capture_output=True).returncode != 0:
        sh("(apt-get update -qq && apt-get install -y -qq zstd) || (sudo apt-get update -qq && sudo apt-get install -y -qq zstd)")
    sh("curl -fsSL https://ollama.com/install.sh | sh")

print("Installed. Starting Ollama…", flush=True)
server = subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(60):
    try:
        requests.get("http://127.0.0.1:11434/api/tags", timeout=2)
        break
    except Exception:
        time.sleep(1)
else:
    raise SystemExit("Ollama did not start. Restart the session (Run -> Restart & clear outputs) and run again.")

# Download the model with a visible percentage (about 9 GB the first time).
print(f"Step 2 of 3: downloading the AI model {MODEL} (about 9 GB, a few minutes)…", flush=True)
last = -10
with requests.post("http://127.0.0.1:11434/api/pull", json={"model": MODEL, "stream": True}, stream=True, timeout=3600) as r:
    for raw in r.iter_lines():
        if not raw:
            continue
        msg = json.loads(raw)
        if msg.get("error"):
            raise SystemExit("Model download failed: " + msg["error"])
        total, done = msg.get("total"), msg.get("completed")
        if total and done:
            pct = int(done * 100 / total)
            if pct >= last + 10:
                last = pct
                print(f"   downloading… {pct}% of {total / 1e9:.1f} GB", flush=True)
        elif msg.get("status") and "pulling" not in msg["status"]:
            print("  ", msg["status"], flush=True)
print("Model ready. Step 3 of 3: connecting to your library…", flush=True)

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
    # Not enough time left for a whole course: stop cleanly instead of
    # being cut off halfway (whatever is unwritten waits for the next run).
    if deadline - time.time() < JOB_MINUTES * 60:
        print("Less than", JOB_MINUTES, "minutes left in this session; not starting another course.", flush=True)
        break
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
            if time.time() > deadline:
                # Session almost over: hand the course back (everything written is kept).
                call(f"/jobs/{job_id}/release", {"error": "Kaggle session ended"})
                print("  Session time is up; handed this course back with its progress saved.", flush=True)
                task = None
                break
            label =f"week {task['week']}" if task["kind"] == "chapter" else task["kind"]
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
