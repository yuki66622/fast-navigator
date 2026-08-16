#!/usr/bin/env python3
"""Fast Navigator LLM sidecar (V2).

Converts a natural-language people-search request into the structured query
JSON the extension's deterministic engine executes. The LLM never sees indexed
page data — only the user's query text and the list of field NAMES.

Privacy / key handling:
  - binds 127.0.0.1 only; the API key lives in .env (never in the browser)
  - mock mode (default when no key, placeholder key, or MOCK_LLM=1) is a
    deterministic rule-based converter — zero dependencies, fully offline
  - real mode calls OpenRouter's REST API via stdlib urllib (no pip installs)

Endpoints:
  GET  /v1/health         -> {ok, mode, model}
  POST /v1/parse-query    {query, fields?} -> {ok, structured, source, model?, note?}

Run:  python3 sidecar/server.py          (SIDECAR_PORT env overrides 8787)
"""
import json
import os
import re
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_FIELDS = ["name", "company", "role", "location", "employees", "industries"]
MAX_QUERY_LEN = 500
MAX_GROUPS, MAX_TERMS, MAX_TERM_LEN, MAX_NONE = 6, 8, 40, 6


def load_env():
    """Tiny .env reader (KEY=VALUE lines); real env vars win."""
    path = os.path.join(ROOT, ".env")
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


load_env()
API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODEL = os.environ.get("OPENROUTER_MODEL", "deepseek/deepseek-chat")
PORT = int(os.environ.get("SIDECAR_PORT", "8787"))
MOCK = (
    os.environ.get("MOCK_LLM") == "1"
    or not API_KEY
    or "your" in API_KEY.lower()
    or API_KEY.startswith("sk-...")
)
MODE = "mock" if MOCK else "llm"

# ---- clamping (applies to BOTH modes; the engine additionally ignores junk) --


def clamp_structured(raw, fields):
    out = {"all": [], "none": []}
    if not isinstance(raw, dict):
        return out
    for g in (raw.get("all") or [])[:MAX_GROUPS]:
        if not isinstance(g, dict):
            continue
        terms = [
            str(t).strip().lower()[:MAX_TERM_LEN]
            for t in (g.get("anyOf") or [])[:MAX_TERMS]
            if str(t).strip()
        ]
        if not terms:
            continue
        group = {"anyOf": terms}
        field = g.get("field")
        if isinstance(field, str) and field in fields:
            group["field"] = field
        out["all"].append(group)
    out["none"] = [
        str(t).strip().lower()[:MAX_TERM_LEN]
        for t in (raw.get("none") or [])[:MAX_NONE]
        if str(t).strip()
    ]
    return out


# ---- mock converter (deterministic; deliberately simple, demo/test grade) ----

ROLE_SYNONYMS = {
    "founder": ["founder", "co-founder"],
    "ceo": ["ceo", "chief executive"],
    "cto": ["cto", "chief technology"],
    "recruiter": ["recruiter", "recruiting", "talent"],
    "engineer": ["engineer", "engineering"],
    "manager": ["manager"],
    "sales": ["sales", "account executive"],
}
LOCATIONS = [
    "berlin", "london", "new york", "tokyo", "austin", "seattle", "boston",
    "amsterdam", "toronto", "singapore", "sydney", "san francisco",
]
CN_MAP = {
    "创始人": "founder", "技术负责人": "cto", "招聘": "recruiter",
    "工程师": "engineer", "销售": "sales",
    "柏林": "berlin", "伦敦": "london", "纽约": "new york", "东京": "tokyo",
}
STOPWORDS = {
    "find", "the", "for", "people", "who", "are", "and", "with", "all",
    "show", "give", "list", "在", "的", "找",
}


def naive_singular(t):
    return t[:-1] if len(t) > 4 and t.endswith("s") else t


def mock_convert(query):
    q = query.lower()
    for cn, en in CN_MAP.items():
        q = q.replace(cn, " " + en + " ")
    none = [naive_singular(m) for m in re.findall(r"(?:\bnot\b|\bexclude\b|\bwithout\b|(?<=\s)-)\s*([a-z]+)", q)]
    q = re.sub(r"(?:\bnot\b|\bexclude\b|\bwithout\b|(?<=\s)-)\s*[a-z]+", " ", q)
    groups = []
    for loc in LOCATIONS:
        if loc in q:
            groups.append({"anyOf": [loc], "field": "location"})
            q = q.replace(loc, " ")
    for key, syns in ROLE_SYNONYMS.items():
        if re.search(r"\b" + key + r"s?\b", q):
            groups.append({"anyOf": syns, "field": "role"})
            q = re.sub(r"\b" + key + r"s?\b", " ", q)
    for tok in re.findall(r"[a-z]{3,}", q):
        if tok not in STOPWORDS:
            groups.append({"anyOf": [tok]})
    return {"all": groups, "none": none}


# ---- real mode: OpenRouter chat completion, constrained JSON -----------------

SYSTEM_PROMPT = """You convert a natural-language people-search request into a JSON query.
Output ONLY a JSON object, no prose, matching:
{"all": [{"anyOf": ["term", ...], "field": "<optional field name>"}, ...], "none": ["term", ...]}
Semantics: within a group the terms are OR (synonyms/alternatives); groups are ANDed;
"none" terms exclude records. Terms are lowercase substrings matched against field values.
Available fields: %s. Only use "field" when confident; omit it otherwise.
Expand role titles into common synonyms (e.g. technical leader -> cto, vp engineering, head of engineering).
Keep it minimal: at most %d groups, %d terms per group."""

FEWSHOT = [
    ("find founders at AI startups in Berlin",
     '{"all":[{"anyOf":["founder","co-founder"],"field":"role"},{"anyOf":["ai"]},{"anyOf":["berlin"],"field":"location"}],"none":[]}'),
    ("engineering leaders, not interns",
     '{"all":[{"anyOf":["vp engineering","engineering manager","head of engineering","cto"],"field":"role"}],"none":["intern"]}'),
]


def llm_convert(query, fields):
    messages = [{"role": "system", "content": SYSTEM_PROMPT % (", ".join(fields), MAX_GROUPS, MAX_TERMS)}]
    for q, a in FEWSHOT:
        messages.append({"role": "user", "content": q})
        messages.append({"role": "assistant", "content": a})
    messages.append({"role": "user", "content": query})
    body = json.dumps({
        "model": MODEL,
        "messages": messages,
        "temperature": 0,
        "max_tokens": 300,
        "response_format": {"type": "json_object"},
    }).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={
            "Authorization": "Bearer " + API_KEY,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://localhost/fast-navigator",
            "X-Title": "Fast Navigator sidecar",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    content = data["choices"][0]["message"]["content"]
    content = re.sub(r"^```(?:json)?|```$", "", content.strip(), flags=re.M).strip()
    return json.loads(content)


# ---- HTTP plumbing ------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/v1/health":
            self._send(200, {"ok": True, "mode": MODE, "model": MODEL if MODE == "llm" else None})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/v1/parse-query":
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            length = min(int(self.headers.get("Content-Length", 0)), 16384)
            req = json.loads(self.rfile.read(length).decode("utf-8"))
            query = str(req.get("query", "")).strip()
            if not query or len(query) > MAX_QUERY_LEN:
                self._send(400, {"ok": False, "error": "query must be 1-%d chars" % MAX_QUERY_LEN})
                return
            fields = [f for f in req.get("fields", DEFAULT_FIELDS) if isinstance(f, str)][:20] or DEFAULT_FIELDS
            if MODE == "mock":
                structured = clamp_structured(mock_convert(query), fields)
                self._send(200, {"ok": True, "structured": structured, "source": "mock"})
                return
            try:
                structured = clamp_structured(llm_convert(query, fields), fields)
                self._send(200, {"ok": True, "structured": structured, "source": "llm", "model": MODEL})
            except Exception as e:  # LLM/network/parse failure -> degrade, never 500
                structured = clamp_structured(mock_convert(query), fields)
                self._send(200, {
                    "ok": True, "structured": structured, "source": "mock",
                    "note": "llm unavailable, used mock converter (%s)" % type(e).__name__,
                })
        except Exception as e:
            self._send(400, {"ok": False, "error": "bad request: %s" % type(e).__name__})

    def log_message(self, fmt, *args):
        pass  # keep stdout quiet; this runs as a background sidecar


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("Fast Navigator sidecar on http://127.0.0.1:%d (mode: %s)" % (PORT, MODE))
    server.serve_forever()
