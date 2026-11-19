"""对私有 opencode serve（test/serve-isolated.sh）直接造授权判定，逐条看台账。

用法：python3 -I test/accept.py <scenario> [args...]
  session <dir>                         建会话，打印 id
  assert <sid> <action> <resource...>   发一次判定，打印 HTTP 结果与用时（PN_META='{...}' 附 metadata，
                                        PN_DIR=<项目目录> 让请求落到该位置的实例上，宿主规则才按那个项目算）
  agent <dir> [agent]                   打印该 location 下合并后的宿主规则
"""

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("PN_BASE", "http://127.0.0.1:4199")
AUTH = "Basic " + base64.b64encode(f"opencode:{os.environ.get('OPENCODE_SERVER_PASSWORD', 'pn-accept')}".encode()).decode()


def call(method, path, body=None, directory=None, timeout=400):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("authorization", AUTH)
    req.add_header("content-type", "application/json")
    if directory:
        req.add_header("x-opencode-directory", urllib.parse.quote(directory))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode()
            return resp.status, json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def main():
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "session":
        status, body = call("POST", "/api/session", {"title": "pn-accept", "location": {"directory": args[0]}}, directory=args[0])
        print((body.get("data") or body).get("id") if isinstance(body, dict) else (status, body))
    elif cmd == "assert":
        sid, action, resources = args[0], args[1], args[2:]
        t0 = time.time()
        status, body = call("POST", f"/api/session/{sid}/permission", {"agent": "build", "action": action, "resources": resources, **({"metadata": json.loads(os.environ["PN_META"])} if os.environ.get("PN_META") else {})}, directory=os.environ.get("PN_DIR"))
        print(json.dumps({"status": status, "ms": int((time.time() - t0) * 1000), "body": body}, ensure_ascii=False))
    elif cmd == "agent":
        q = urllib.parse.quote(args[0])
        status, body = call("GET", f"/api/agent/{args[1] if len(args) > 1 else 'build'}?location[directory]={q}")
        data = body.get("data", body) if isinstance(body, dict) else body
        print(json.dumps(data.get("permissions") if isinstance(data, dict) else (status, body), ensure_ascii=False))


main()
