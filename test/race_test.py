"""对一个独立的 opencode serve 造授权请求，按不同时机在"别处"回答，看插件的反应。

用法：python3 -I test/race_test.py <base_url> <password> <directory> <scenario...>
场景：
  instant      创建后立即用 once 回答（模拟 opencode run --auto）
  late=<ms>    创建后 <ms> 毫秒再回答（模拟慢速自动批准 / 人在 OpenCode 窗口里点）
  human        不在别处回答，等插件里的"点击"回答
  repeat       与 human 同一资源再发一次，看是否已被"总是允许"放行
"""

import base64
import json
import sys
import threading
import time
import urllib.error
import urllib.request

BASE, PASSWORD, DIRECTORY = sys.argv[1], sys.argv[2], sys.argv[3]
AUTH = "Basic " + base64.b64encode(f"opencode:{PASSWORD}".encode()).decode()


def call(method, path, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("authorization", AUTH)
    req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode()
            body = json.loads(text) if text else None
            if isinstance(body, dict) and "data" in body:
                body = body["data"]
            return resp.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def stamp():
    return time.strftime("%H:%M:%S", time.gmtime()) + f".{int(time.time() * 1000) % 1000:03d}Z"


def pending(sid):
    _, body = call("GET", f"/api/session/{sid}/permission")
    return [p.get("id") for p in body] if isinstance(body, list) else body


def ask(sid, resource, reply_after_ms=None):
    """创建请求（可能阻塞到被回答），返回 (status, body, 用时 ms)"""
    t0 = time.time()
    rid = f"per_{int(t0 * 1000):x}test{resource[-4:].replace('/', '')}"
    # 先拿到 id 才能在别处回答：自己指定 id
    payload = {"agent": "build", "action": "external_directory", "resources": [resource], "save": [resource]}
    result = {}

    def create():
        result["status"], result["body"] = call("POST", f"/api/session/{sid}/permission", payload, timeout=120)
        result["ms"] = int((time.time() - t0) * 1000)

    th = threading.Thread(target=create)
    th.start()
    if reply_after_ms is not None:
        # 轮询待处理列表拿到请求 id，再按约定延迟回答
        rid = None
        while rid is None and th.is_alive():
            ids = pending(sid)
            rid = ids[0] if isinstance(ids, list) and ids else None
        if rid:
            wait = reply_after_ms / 1000 - (time.time() - t0)
            if wait > 0:
                time.sleep(wait)
            status, body = call("POST", f"/api/session/{sid}/permission/{rid}/reply", {"decision": "once"})
            print(f"  {stamp()} 别处回答 {rid} once -> {status} (t={int((time.time() - t0) * 1000)}ms)")
    th.join()
    return result.get("status"), result.get("body"), result.get("ms")


def main():
    status, session = call("POST", "/api/session", {"title": "pn-race-test", "location": {"directory": DIRECTORY}})
    sid = session.get("id") if isinstance(session, dict) else None
    print(f"{stamp()} session {status} {sid}")
    for scenario in sys.argv[4:]:
        print(f"{stamp()} == {scenario}")
        if scenario == "probe":
            print("  ", ask(sid, "/tmp/pn-race-probe/*", reply_after_ms=0))
        elif scenario == "instant":
            print("  ", ask(sid, "/tmp/pn-race-instant/*", reply_after_ms=0))
        elif scenario.startswith("late="):
            print("  ", ask(sid, "/tmp/pn-race-late/*", reply_after_ms=int(scenario[5:])))
        elif scenario in ("human", "repeat"):
            print("  ", ask(sid, "/tmp/pn-race-human/*"))
            if scenario == "human":
                time.sleep(6)  # 等假助手"点击"
            print(f"  pending={pending(sid)}")
        time.sleep(4)
    print(f"{stamp()} done, pending={pending(sid)}")


main()
