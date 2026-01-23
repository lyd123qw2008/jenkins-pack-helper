import json
import os
import threading
import time
import uuid
from typing import Any, Dict, List

from flask import Flask, jsonify, request

import pack_helper

APP_ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(APP_ROOT, "config.json")

app = Flask(__name__)

_tasks_lock = threading.Lock()
_tasks: Dict[str, Dict[str, Any]] = {}


def _new_task() -> str:
    task_id = str(uuid.uuid4())
    with _tasks_lock:
        _tasks[task_id] = {
            "status": "pending",
            "result": "",
            "error": "",
            "started_at": time.time(),
            "finished_at": None,
            "logs": [],
        }
    return task_id


def _append_log(task_id: str, msg: str) -> None:
    with _tasks_lock:
        if task_id in _tasks:
            _tasks[task_id]["logs"].append(msg)


def _finish_task(task_id: str, status: str, result: str = "", error: str = "") -> None:
    with _tasks_lock:
        if task_id in _tasks:
            _tasks[task_id]["status"] = status
            _tasks[task_id]["result"] = result
            _tasks[task_id]["error"] = error
            _tasks[task_id]["finished_at"] = time.time()


def load_config() -> Dict[str, Any]:
    return pack_helper.load_config(CONFIG_PATH)


def save_config(cfg: Dict[str, Any]) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def build_worker(task_id: str, jobs_payload: List[Dict[str, Any]], timeouts: Dict[str, int]) -> None:
    try:
        cfg = load_config()
        results: List[str] = []
        for job_item in jobs_payload:
            job_key = job_item["job_key"]
            params = job_item.get("params", {})
            job_conf = cfg["jobs"].get(job_key)
            if not job_conf:
                raise KeyError(f"Job '{job_key}' not found in config")

            args = type("Args", (), {})()
            args.param = [f"{k}={v}" for k, v in params.items()]
            args.poll_seconds = int(timeouts.get("poll_seconds", 10))
            args.queue_timeout = int(timeouts.get("queue_timeout", 600))
            args.build_timeout = int(timeouts.get("build_timeout", 3600))

            _append_log(task_id, f"Triggering {job_key} ...")
            result = pack_helper.build_job(job_key, job_conf, args, cfg)
            results.append(result)
            _append_log(task_id, f"Done: {job_key}")

        _finish_task(task_id, "success", "\n".join(results), "")
    except Exception as ex:
        _finish_task(task_id, "error", "", str(ex))


@app.get("/api/jobs")
def api_jobs():
    try:
        cfg = load_config()
        return jsonify(cfg)
    except Exception as ex:
        return jsonify({"error": str(ex)}), 500


@app.post("/api/config")
def api_save_config():
    data = request.get_json(force=True)
    save_config(data)
    return jsonify({"ok": True})


@app.post("/api/build")
def api_build():
    data = request.get_json(force=True)
    jobs_payload = data.get("jobs", [])
    if not jobs_payload:
        return jsonify({"error": "No jobs specified"}), 400
    timeouts = data.get("timeouts", {})

    task_id = _new_task()
    t = threading.Thread(target=build_worker, args=(task_id, jobs_payload, timeouts), daemon=True)
    t.start()
    return jsonify({"task_id": task_id})


@app.get("/api/status/<task_id>")
def api_status(task_id: str):
    with _tasks_lock:
        task = _tasks.get(task_id)
        if not task:
            return jsonify({"error": "Task not found"}), 404
        return jsonify(task)


@app.get("/")
def index():
    return """
<!doctype html>
<html lang=\"zh-CN\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>Jenkins Pack Helper</title>
  <style>
    :root { --bg:#f6f7fb; --card:#fff; --ink:#222; --muted:#666; --accent:#2b6cb0; }
    body { font-family: Segoe UI, Arial, sans-serif; background: var(--bg); color: var(--ink); margin: 0; }
    header { padding: 16px 24px; background: #0f172a; color: #fff; }
    main { padding: 20px 24px; display: grid; gap: 16px; }
    .card { background: var(--card); border-radius: 10px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    label { font-size: 12px; color: var(--muted); }
    input, textarea { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 6px; }
    button { background: var(--accent); color: #fff; border: 0; padding: 8px 12px; border-radius: 6px; cursor: pointer; }
    button.secondary { background: #334155; }
    .jobs { display: grid; gap: 12px; }
    .job { border: 1px solid #eee; border-radius: 8px; padding: 12px; }
    .job h4 { margin: 0 0 6px 0; }
    .muted { color: var(--muted); font-size: 12px; }
    .result { white-space: pre-wrap; background: #0b1020; color: #cbd5e1; padding: 12px; border-radius: 8px; }
  </style>
</head>
<body>
  <header>
    <h2>Jenkins Pack Helper</h2>
  </header>
  <main>
    <section class=\"card\">
      <h3>Jenkins 配置</h3>
      <div class=\"row\">
        <div><label>Base URL</label><input id=\"cfg-base\"/></div>
        <div><label>User</label><input id=\"cfg-user\"/></div>
        <div><label>Password</label><input id=\"cfg-pass\" type=\"password\"/></div>
        <div><label>API Token</label><input id=\"cfg-token\" type=\"password\"/></div>
      </div>
      <div class=\"row\" style=\"margin-top:8px;\">
        <div><label>Verify SSL</label><input id=\"cfg-ssl\"/></div>
        <div><label>Timeout Seconds</label><input id=\"cfg-timeout\"/></div>
        <div style=\"display:flex;align-items:end;\"><button id=\"save-cfg\">保存配置</button></div>
      </div>
      <div class=\"muted\" id=\"cfg-msg\"></div>
    </section>

    <section class=\"card\">
      <h3>构建任务</h3>
      <div class=\"jobs\" id=\"jobs\"></div>
      <div style=\"margin-top:10px; display:flex; gap:8px;\">
        <button id=\"run\">运行选择</button>
        <button class=\"secondary\" id=\"copy\">复制结果</button>
      </div>
      <div class=\"muted\" id=\"run-msg\"></div>
    </section>

    <section class=\"card\">
      <h3>执行结果</h3>
      <div class=\"result\" id=\"result\"></div>
      <div class=\"muted\" id=\"logs\"></div>
    </section>
  </main>
<script>
let CFG = null;
let LAST_RESULT = '';

function el(id){ return document.getElementById(id); }

async function loadConfig(){
  const res = await fetch('/api/jobs');
  CFG = await res.json();
  if(!res.ok){
    el('cfg-msg').textContent = '配置加载失败：' + (CFG.error || 'unknown');
    return;
  }
  el('cfg-base').value = CFG.jenkins.base_url || '';
  el('cfg-user').value = CFG.jenkins.user || '';
  el('cfg-pass').value = CFG.jenkins.password || '';
  el('cfg-token').value = CFG.jenkins.api_token || '';
  el('cfg-ssl').value = CFG.jenkins.verify_ssl;
  el('cfg-timeout').value = CFG.jenkins.timeout_seconds;
  renderJobs();
}

function renderJobs(){
  const root = el('jobs');
  root.innerHTML = '';
  Object.keys(CFG.jobs || {}).forEach(key => {
    const job = CFG.jobs[key];
    const wrap = document.createElement('div');
    wrap.className = 'job';
    wrap.innerHTML =
      '<label><input type="checkbox" class="job-check" data-key="' + key + '"> ' + key + '</label>' +
      '<h4>' + (job.job_name || '') + '</h4>' +
      '<div class="muted">type: ' + (job.type || '-') + ' </div>' +
      '<div class="params" data-key="' + key + '"></div>';
    root.appendChild(wrap);

    const paramsDiv = wrap.querySelector('.params');
    const params = job.parameters || {};
    Object.keys(params).forEach(p => {
      const v = params[p] || '';
      const row = document.createElement('div');
      row.innerHTML = '<label>' + p + '</label><input data-param="' + p + '" data-job="' + key + '" value="' + v + '"/>';
      paramsDiv.appendChild(row);
    });
  });
}

async function saveConfig(){
  CFG.jenkins.base_url = el('cfg-base').value.trim();
  CFG.jenkins.user = el('cfg-user').value.trim();
  CFG.jenkins.password = el('cfg-pass').value;
  CFG.jenkins.api_token = el('cfg-token').value;
  CFG.jenkins.verify_ssl = String(el('cfg-ssl').value).toLowerCase() === 'true';
  CFG.jenkins.timeout_seconds = parseInt(el('cfg-timeout').value || '30', 10);

  const res = await fetch('/api/config', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(CFG)});
  if(res.ok){ el('cfg-msg').textContent = '已保存'; }
  else { el('cfg-msg').textContent = '保存失败'; }
}

async function runBuild(){
  const checks = Array.from(document.querySelectorAll('.job-check')).filter(c => c.checked);
  if(!checks.length){ el('run-msg').textContent = '请选择至少一个任务'; return; }
  const jobs = [];
  checks.forEach(c => {
    const key = c.dataset.key;
    const params = {};
    document.querySelectorAll('input[data-job="' + key + '"]').forEach(inp => {
      const v = inp.value.trim();
      if(v) params[inp.dataset.param] = v;
    });
    jobs.push({job_key:key, params});
  });

  const res = await fetch('/api/build', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({jobs})});
  const data = await res.json();
  if(!res.ok){ el('run-msg').textContent = data.error || '启动失败'; return; }
  el('run-msg').textContent = '已启动，等待完成...';
  pollStatus(data.task_id);
}

async function pollStatus(taskId){
  const res = await fetch('/api/status/' + taskId);
  const data = await res.json();
  if(data.error){ el('run-msg').textContent = data.error; return; }
  el('logs').textContent = (data.logs || []).join('\\n');
  if(data.status === 'success'){
    LAST_RESULT = data.result || '';
    el('result').textContent = LAST_RESULT;
    el('run-msg').textContent = '完成';
    return;
  }
  if(data.status === 'error'){
    el('run-msg').textContent = '失败：' + data.error;
    return;
  }
  setTimeout(() => pollStatus(taskId), 2000);
}

function copyResult(){
  if(!LAST_RESULT){ return; }
  navigator.clipboard.writeText(LAST_RESULT).catch(()=>{});
}

el('save-cfg').addEventListener('click', saveConfig);
el('run').addEventListener('click', runBuild);
el('copy').addEventListener('click', copyResult);

loadConfig();
</script>
</body>
</html>
    """


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
