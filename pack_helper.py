import argparse
import getpass
import json
import os
import re
import sys
import time
from typing import Dict, Any, List, Optional

import requests


def eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def load_config(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        raise FileNotFoundError(f"Config not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_crumb(session: requests.Session, base_url: str, verify: bool, timeout: int) -> Optional[Dict[str, str]]:
    url = base_url.rstrip("/") + "/crumbIssuer/api/json"
    try:
        resp = session.get(url, verify=verify, timeout=timeout)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        data = resp.json()
        return {data.get("crumbRequestField", "Jenkins-Crumb"): data.get("crumb", "")}
    except requests.RequestException:
        return None


def trigger_build(
    session: requests.Session,
    base_url: str,
    job_name: str,
    params: Dict[str, str],
    headers: Dict[str, str],
    verify: bool,
    timeout: int,
) -> str:
    if params:
        url = base_url.rstrip("/") + f"/job/{job_name}/buildWithParameters"
        resp = session.post(url, data=params, headers=headers, verify=verify, timeout=timeout, allow_redirects=False)
    else:
        url = base_url.rstrip("/") + f"/job/{job_name}/build"
        resp = session.post(url, headers=headers, verify=verify, timeout=timeout, allow_redirects=False)
        if resp.status_code == 400 and "Nothing is submitted" in resp.text:
            url = base_url.rstrip("/") + f"/job/{job_name}/buildWithParameters"
            resp = session.post(url, data={}, headers=headers, verify=verify, timeout=timeout, allow_redirects=False)

    if resp.status_code not in (200, 201, 202, 302):
        raise RuntimeError(f"Failed to trigger build: HTTP {resp.status_code} {resp.text}")

    location = resp.headers.get("Location")
    if not location:
        raise RuntimeError("Build triggered but no queue Location header found.")
    return location


def wait_for_executable(
    session: requests.Session,
    queue_url: str,
    verify: bool,
    timeout: int,
    poll_seconds: int,
    max_wait_seconds: int,
) -> int:
    end_time = time.time() + max_wait_seconds
    api_url = queue_url.rstrip("/") + "/api/json"
    while time.time() < end_time:
        resp = session.get(api_url, verify=verify, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
        if "executable" in data and data["executable"]:
            return int(data["executable"]["number"])
        if data.get("cancelled"):
            raise RuntimeError("Build cancelled in queue.")
        time.sleep(poll_seconds)
    raise TimeoutError("Timeout waiting for Jenkins to assign build number.")


def wait_for_build_complete(
    session: requests.Session,
    base_url: str,
    job_name: str,
    build_number: int,
    verify: bool,
    timeout: int,
    poll_seconds: int,
    max_wait_seconds: int,
) -> str:
    end_time = time.time() + max_wait_seconds
    api_url = base_url.rstrip("/") + f"/job/{job_name}/{build_number}/api/json"
    while time.time() < end_time:
        resp = session.get(api_url, verify=verify, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
        if not data.get("building", False):
            return data.get("result") or "UNKNOWN"
        time.sleep(poll_seconds)
    raise TimeoutError("Timeout waiting for Jenkins build to complete.")


def fetch_console_text(
    session: requests.Session,
    base_url: str,
    job_name: str,
    build_number: int,
    verify: bool,
    timeout: int,
) -> str:
    url = base_url.rstrip("/") + f"/job/{job_name}/{build_number}/consoleText"
    resp = session.get(url, verify=verify, timeout=timeout)
    resp.raise_for_status()
    return resp.text


def extract_result(console_text: str, patterns: List[str]) -> Optional[str]:
    matches: List[str] = []
    for pattern in patterns:
        try:
            for m in re.finditer(pattern, console_text, flags=re.MULTILINE):
                if m.groups():
                    matches.append("".join(m.groups()))
                else:
                    matches.append(m.group(0))
        except re.error as ex:
            raise RuntimeError(f"Invalid regex pattern: {pattern} ({ex})")
    if matches:
        return matches[-1].strip()
    return None


def copy_to_clipboard(text: str) -> None:
    try:
        import subprocess

        subprocess.run(
            ["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $input"],
            input=text,
            text=True,
            check=True,
        )
    except Exception:
        eprint("Warning: failed to copy to clipboard.")


def build_job(job_key: str, job_conf: Dict[str, Any], args: argparse.Namespace, cfg: Dict[str, Any]) -> str:
    jenkins = cfg["jenkins"]
    base_url = jenkins["base_url"]
    user = jenkins["user"]
    token = jenkins.get("api_token", "")
    password = jenkins.get("password", "")
    verify_ssl = bool(jenkins.get("verify_ssl", True))
    timeout = int(jenkins.get("timeout_seconds", 30))

    job_name = job_conf["job_name"]
    patterns = job_conf.get("success_patterns", [])
    result_template = job_conf.get("result_template", "{match}")

    params = dict(job_conf.get("parameters", {}))
    for kv in args.param:
        if "=" not in kv:
            raise ValueError(f"Invalid --param '{kv}', expected key=value")
        k, v = kv.split("=", 1)
        params[k] = v

    # If parameters are required (non-empty keys), ensure they are filled.
    for k, v in params.items():
        if v is None or str(v).strip() == "":
            raise ValueError(f"Missing parameter for job '{job_key}': {k}")

    if not token:
        token = password
    if not token:
        token = os.environ.get("JENKINS_PASS", "")
    if not token:
        token = getpass.getpass("Jenkins password (input hidden): ").strip()
    if not token:
        raise ValueError("Missing Jenkins password/api_token.")

    session = requests.Session()
    session.auth = (user, token)

    headers: Dict[str, str] = {}
    crumb = get_crumb(session, base_url, verify_ssl, timeout)
    if crumb:
        headers.update(crumb)

    print(f"Triggering job '{job_name}'...")
    queue_url = trigger_build(session, base_url, job_name, params, headers, verify_ssl, timeout)

    print("Waiting for build number...")
    build_number = wait_for_executable(
        session,
        queue_url,
        verify_ssl,
        timeout,
        poll_seconds=args.poll_seconds,
        max_wait_seconds=args.queue_timeout,
    )

    print(f"Build number: {build_number}")
    print("Waiting for build completion...")
    result = wait_for_build_complete(
        session,
        base_url,
        job_name,
        build_number,
        verify_ssl,
        timeout,
        poll_seconds=args.poll_seconds,
        max_wait_seconds=args.build_timeout,
    )

    if result != "SUCCESS":
        raise RuntimeError(f"Build failed: {job_name} #{build_number} result={result}")

    console_text = fetch_console_text(session, base_url, job_name, build_number, verify_ssl, timeout)
    match = extract_result(console_text, patterns)
    if not match:
        raise RuntimeError("No success message matched in console output. Update success_patterns.")

    return result_template.format(match=match, job=job_name, build_number=build_number)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Jenkins build helper")
    parser.add_argument("command", choices=["build"], help="Command to run")
    parser.add_argument("jobs", nargs="+", help="Job keys defined in config.json")
    parser.add_argument("--config", default="config.json", help="Config file path")
    parser.add_argument("--param", action="append", default=[], help="Build parameter key=value")
    parser.add_argument("--poll-seconds", type=int, default=10, help="Polling interval")
    parser.add_argument("--queue-timeout", type=int, default=600, help="Max seconds to wait in queue")
    parser.add_argument("--build-timeout", type=int, default=3600, help="Max seconds to wait for build")
    parser.add_argument("--copy", action="store_true", help="Copy result to clipboard")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cfg = load_config(args.config)
    results: List[str] = []

    for job_key in args.jobs:
        if job_key not in cfg.get("jobs", {}):
            raise KeyError(f"Job '{job_key}' not found in config")
        job_conf = cfg["jobs"][job_key]
        results.append(build_job(job_key, job_conf, args, cfg))

    output = "\n".join(results)
    print("\n=== RESULT ===\n" + output)

    if args.copy:
        copy_to_clipboard(output)
        print("Copied to clipboard.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as ex:
        eprint(f"Error: {ex}")
        sys.exit(1)
