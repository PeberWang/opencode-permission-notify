"""校验判定台账：每行都是 JSON、字段齐全、取值合法，同一次判定不重复。

用法：python3 -I test/check-ledger.py <ledger.jsonl> [预期行数]
"""

import json
import sys
from collections import Counter

REQUIRED = ["v", "ts", "session", "action", "resources", "host_effect", "class", "source", "tier", "reason", "why", "effect"]
ENUMS = {
    "host_effect": {"allow", "ask", "deny"},
    "class": {"1", "2", "3", "4", "5", "6"},
    "source": {"default", "user", "host"},
    "tier": {"human", "pm", "silent", "deny"},
    "effect": {"allow", "deny"},
}

path = sys.argv[1]
expected = int(sys.argv[2]) if len(sys.argv) > 2 else None
rows, problems = [], []
with open(path, encoding="utf-8") as f:
    for n, line in enumerate(f, 1):
        try:
            row = json.loads(line)
        except json.JSONDecodeError as e:
            problems.append(f"第 {n} 行不是 JSON：{e}")
            continue
        missing = [k for k in REQUIRED if k not in row or row[k] in (None, "")]
        if missing:
            problems.append(f"第 {n} 行缺字段：{missing}")
        for k, allowed in ENUMS.items():
            if k in row and row[k] not in allowed:
                problems.append(f"第 {n} 行 {k}={row[k]!r} 不合法")
        if not isinstance(row.get("resources"), list):
            problems.append(f"第 {n} 行 resources 不是数组")
        rows.append(row)

# 同一次工具调用的同一道检查只能有一行；直接断言没有 call，按会话+动作+资源+时间秒级去重检查
keys = Counter((r.get("session"), r.get("call") or r.get("ts")[:19], r.get("action"), tuple(r.get("resources") or [])) for r in rows)
dups = [k for k, c in keys.items() if c > 1]
for k in dups:
    problems.append(f"重复判定：{k}")

print(f"台账 {path}：{len(rows)} 行")
print("按类：", dict(sorted(Counter(r.get("class") for r in rows).items())))
print("按来源：", dict(sorted(Counter(r.get("source") for r in rows).items())))
print("按档位：", dict(sorted(Counter(r.get("tier") for r in rows).items())))
if expected is not None:
    print(f"预期 {expected} 行，实际 {len(rows)} 行：{'一致' if expected == len(rows) else '不一致'}")
    if expected != len(rows):
        problems.append("行数与预期不一致")
print("问题：无" if not problems else "问题：\n  " + "\n  ".join(problems))
sys.exit(1 if problems else 0)
