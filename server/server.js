// pocket-terminal 서버: 아이폰 앱의 창 하나 = Mac의 tmux 세션 하나. 창마다 claude를 따로 돌릴 수 있다.
// 연결이 끊겨도 tmux 안의 작업(claude 등)은 계속 돌고, 다시 붙으면 같은 화면으로 이어진다.
// 앱이 만든 세션 이름은 "pt-"로 시작한다 (Mac에서 직접 만든 tmux 세션과 섞이지 않게).
//
// 주고받는 방식
//   앱 → 서버: 텍스트 JSON  {"t":"i","d":"입력 글자"}  |  {"t":"r","c":열,"r":행}
//   서버 → 앱: 터미널 출력 그대로(바이너리)
//   창 열기: ws://주소:8790/term?session=pt-이름   (없으면 새로 만듦)
//   창 목록: GET /sessions   → [{"name","created","attached"}]
//   창 닫기(세션 끝내기): DELETE /sessions/pt-이름
//   사진·영상 올리기: POST /upload  (본문 = JPEG·PNG·MP4·MOV, 95MB까지) → ~/.pocket-terminal/uploads/에 저장하고 {"path"} 를 돌려준다.
//                앱이 그 경로를 입력창에 넣어 Claude가 사진을 읽게 한다
//   Claude 사용량: GET /sessions/pt-이름/statusline  (~/.claude/statusline.sh가 적어 둔 statusline/pt-이름.json 그대로)
//   에이전트 목록: GET /agents   만들기·고치기: PUT /agents/<이름> (JSON: description, tools, model, prompt)
//   에이전트 지우기: DELETE /agents/<이름>  (백업 폴더로 옮김)
//   팀: POST /teams/plan {goal, folder} → Claude가 팀원·역할을 짜서 만든다
//       GET /teams/<id>/status (사무실 화면), POST /teams/<id>/order {text} (사장 → 팀장 지시)
//       GET /teams, POST /teams, PUT|DELETE /teams/<id>, POST /teams/<id>/start|stop, GET /teams/<id>/board
//       GET /teams/<id>/drawer (사무실 서랍: 목표 결과물·아티팩트, drawer.js)
//       GET /folders  (팀이 일할 폴더 후보)
//   알림: GET /approvals?wait=1 → {pending: 새 기기 승인 요청, permissions: [Claude 권한 요청]} (생길 때까지 25초 기다림)
//         POST /approvals/<번호> {allow}  새 기기 수락·거절,  POST /permissions/<번호> {allow}  Claude 권한 허용·거절
//   결과물: GET /files?path=&team=   사용량: GET /usage
//   푸시: POST /push/register {token, env}, POST /push/activity {team, token}  (앱을 닫아도 오는 알림, push.js)
//   권한 훅: POST /hook/permission  (이 컴퓨터의 permission-hook.js만. 터널로 온 요청은 받지 않는다)
// 인증: 모든 요청에 Authorization: Bearer <~/.pocket-terminal/token 내용>. 틀리면 거절하고,
//       같은 곳에서 10분 안에 10번 틀리면 15분 동안 막는다(429).
//       토큰이 맞아도 처음 보는 기기면 이 컴퓨터 화면에서 주인이 허용해야 들어온다(devices.js, 403).
//
// 사용: node server.js            (기본 127.0.0.1:8790 + Tailscale 주소가 있으면 그 주소에도)
//       HOSTS=0.0.0.0 node server.js  → 모든 주소 (같은 와이파이에서 시험할 때만)
//       cloudflared가 있으면 무료 터널로 바깥 주소도 만들어 주소록에 올린다 (tunnel.js, TUNNEL=0이면 끔)
//       폰 연결 QR: node pair.js
const http = require("http");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const agents = require("./agents");
const teams = require("./teams");

const tunnel = require("./tunnel");
const devices = require("./devices");
const permissions = require("./permissions");
const files = require("./files");
const push = require("./push");
const { PORT, TUNNEL_PORT, WORKDIR, HOME, token } = require("./config");
const path = require("path");

const NAME_RE = /^pt-[A-Za-z0-9_-]{1,32}$/;
const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"].find((p) => fs.existsSync(p)) || "tmux";
// 시험용 서버는 PT_TMUX_SOCKET으로 tmux를 따로 쓴다 (실제 창 목록·창에 닿지 않게)
const TMUX_SOCK = process.env.PT_TMUX_SOCKET ? ["-L", process.env.PT_TMUX_SOCKET] : [];

// 처음 실행할 때 토큰이 만들어진다 (QR에 담겨 앱으로 한 번 넘어가는 비밀값)
const TOKEN = token();

function sameToken(given) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 터널(cloudflared)은 터널 전용 포트(TUNNEL_PORT)로만 들어온다. 그 포트로 온 요청만 Cloudflare가 붙여 주는
// 원래 주소(cf-connecting-ip)를 믿는다. 다른 포트에서는 이 머리글을 무시한다(이 Mac의 다른 프로그램이 꾸며 넣을 수 있다).
const viaTunnel = (req) => req.socket.localPort === TUNNEL_PORT;
function clientIP(req) {
  const ip = req.socket.remoteAddress || "";
  const cf = String(req.headers["cf-connecting-ip"] || "");
  return viaTunnel(req) && cf ? cf.slice(0, 64) : ip;
}

// 토큰 확인. "ok" | "bad" | "blocked"
const fails = new Map(); // 주소 → { n: 틀린 횟수, first: 처음 틀린 때, until: 막힌 끝 }
function checkAuth(req) {
  const ip = clientIP(req);
  const now = Date.now();
  const f = fails.get(ip);
  if (f && f.until > now) return "blocked";
  const h = String(req.headers.authorization || "");
  if (sameToken(h.startsWith("Bearer ") ? h.slice(7) : "")) return "ok";
  const r = f && now - f.first < 10 * 60_000 ? f : { n: 0, first: now, until: 0 };
  if (++r.n >= 10) {
    r.until = now + 15 * 60_000;
    console.log(new Date().toISOString(), "잘못된 토큰이 많아 15분 막음", ip);
  }
  fails.set(ip, r);
  return "bad";
}
// 오래된 기록 정리
setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of fails) if (f.until < now && now - f.first > 10 * 60_000) fails.delete(ip);
}, 10 * 60_000).unref();

// Tailscale 주소(100.64.0.0/10)를 찾는다. 없으면 이 Mac 안에서만 열린다.
function tailscaleAddrs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4") continue;
      const [x, y] = a.address.split(".").map(Number);
      if (x === 100 && y >= 64 && y <= 127) out.push(a.address);
    }
  }
  return out;
}

function tmux(args) {
  return execFileSync(TMUX, [...TMUX_SOCK, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function listSessions() {
  let out = "";
  try { out = tmux(["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{session_attached}"]); } catch { return []; }
  const apps = sessionApps();
  return out.trim().split("\n").filter(Boolean).map((l) => l.split("\t"))
    .filter(([n]) => NAME_RE.test(n))
    .map(([name, created, attached]) => ({ name, created: Number(created), attached: Number(attached) > 0,
                                           title: teams.titleFor(name), app: apps[name] || "shell" }));
}

// 창마다 지금 돌고 있는 것: claude | codex | gemini | shell(셸만) | other(그 밖의 프로그램).
// 앱의 창 메뉴가 이것에 맞는 명령을 보여 준다. tmux 창의 셸 아래 자식 프로세스들의 명령 줄을 본다
function sessionApps() {
  const out = {};
  let panes = "", procs = "";
  try {
    panes = tmux(["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}\t#{pane_active}\t#{window_active}"]);
    procs = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 8 << 20 });
  } catch { return out; }
  const kids = new Map(), cmd = new Map();
  for (const line of procs.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    cmd.set(m[1], m[3]);
    if (!kids.has(m[2])) kids.set(m[2], []);
    kids.get(m[2]).push(m[1]);
  }
  const kind = (c) => /(^|\/)claude(\s|$)|@anthropic-ai\/claude-code|\/claude\/versions\//.test(c) ? "claude"
    : /(^|\/)codex(\s|$)|@openai\/codex/.test(c) ? "codex"
    : /(^|\/)gemini(\s|$)|@google\/gemini-cli/.test(c) ? "gemini" : null;
  for (const line of panes.trim().split("\n")) {
    const [name, pid, paneOn, winOn] = line.split("\t");
    if (!NAME_RE.test(name) || paneOn !== "1" || winOn !== "1") continue;
    // 셸 자신이 AI면(팀 창은 exec로 바로 띄운다) 그것, 아니면 자손 중 AI를 찾는다
    let found = kind(cmd.get(pid) || ""), any = false;
    const stack = [...(kids.get(pid) || [])];
    for (let i = 0; !found && i < stack.length && i < 200; i++) {
      any = true;
      found = kind(cmd.get(stack[i]) || "");
      stack.push(...(kids.get(stack[i]) || []));
    }
    out[name] = found || (any ? "other" : "shell");
  }
  return out;
}

// create: "+ 새 창"으로 처음 열 때만 창을 만든다. 아니면 있는 창에 붙기만 한다
// (사라진 창에 폰이 다시 붙으며 빈 창을 되살리지 않게. 창이 없으면 붙지 못하고 끝나며, 폰은 그 탭을 지운다)
const tmuxOpen = (session, create) => create
  ? [...TMUX_SOCK, "-u", "new-session", "-A", "-s", session, "-c", WORKDIR, ";", "set-option", "-t", session, "status", "off"]
  : [...TMUX_SOCK, "-u", "attach-session", "-t", "=" + session, ";", "set-option", "-t", session, "status", "off"];

function attach(ws, session, create) {
  const env = { ...process.env, TERM: "xterm-256color", LANG: "ko_KR.UTF-8", LC_ALL: "ko_KR.UTF-8" };
  // -A: 세션이 있으면 붙고, 없으면 만든다. -c: 새 세션의 시작 폴더
  // 폰 화면이 좁아 tmux 아래 초록 상태줄은 끈다 (이 세션에만)
  const term = pty.spawn(TMUX, tmuxOpen(session, create), {
    name: "xterm-256color", cols: 80, rows: 24, cwd: WORKDIR, env,
  });
  term.onData((d) => ws.readyState === ws.OPEN && ws.send(Buffer.from(d, "utf8")));
  term.onExit(() => ws.close());
  // 너무 큰 글(1MB 넘게)이나 깨진 글이 오면 ws가 error를 낸다. 받지 않으면 서버 전체가 죽는다
  ws.on("error", () => { try { term.kill(); } catch {} });
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return term.write(raw.toString("utf8"));
    let m;
    try { m = JSON.parse(raw.toString("utf8")); } catch { return; }
    if (m.t === "i" && typeof m.d === "string") term.write(m.d);
    else if (m.t === "r" && m.c > 0 && m.r > 0) term.resize(Math.min(m.c, 500), Math.min(m.r, 200));
  });
  // 앱이 끊겨도 tmux 세션은 남는다 (붙어 있던 tmux 클라이언트만 끝낸다)
  ws.on("close", () => { try { term.kill(); } catch {} });
}

// 잘못된 요청 하나로 서버가 죽지 않게 모든 요청을 감싼다 (인증 전 요청 포함)
const server = http.createServer((req, res) => {
  try { handle(req, res); } catch (e) {
    console.log(new Date().toISOString(), "요청 처리 오류", req.method, String(e && e.message).slice(0, 120));
    if (!res.headersSent) { res.writeHead(400); res.end(); }
  }
});

function handle(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health") { res.writeHead(200); return res.end("ok"); }
  // req.relay: 중계(relay.js)가 서버 안에서 직접 넘긴 요청. 토큰·기기 확인은 Noise(psk)와 폰 보안 칩 서명으로 이미 끝났다.
  // 네트워크로 온 요청은 이 표시를 가질 수 없다 (http 모듈이 만든 객체라서)
  const relayed = req.relay === true;
  if (!relayed) {
    const auth = checkAuth(req);
    if (auth !== "ok") { res.writeHead(auth === "blocked" ? 429 : 401); return res.end(); }
  }
  // 이 컴퓨터의 Claude Code 권한 훅. 터널(cloudflared)을 거친 요청에는 cf-connecting-ip가 붙으므로 그런 요청은 막는다
  if (req.method === "POST" && url.pathname === "/hook/permission") {
    if (relayed) { res.writeHead(403); return res.end(); }
    const local = /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress || "") && !viaTunnel(req) && !req.headers["cf-connecting-ip"];
    if (!local) { res.writeHead(403); return res.end(); }
    // 연결한 폰이 없으면 기다릴 이유가 없다 (컴퓨터 질문 창으로만)
    if (!devices.list().length) return json(res, 200, { decision: null });
    return withBody(req, res, (d) => permissions.hold(req, res, d));
  }
  // 영상·소리 재생용 짧은 표 (AVPlayer는 같은 머리글로 여러 번 요청하므로 요청마다 서명할 수 없다).
  // 표는 서명한 요청으로만 받을 수 있고(/files/ticket), 그 파일 하나만 10분 동안 연다. 토큰은 여전히 필요하다.
  const tk = url.pathname.match(/^\/files\/t\/([0-9a-f]{64})$/);
  if (req.method === "GET" && tk) {
    if (relayed) { res.writeHead(404); return res.end(); }
    return files.serveTicket(req, res, tk[1]);
  }
  if (!relayed) {
    const dev = devices.check(req, clientIP(req));
    if (dev !== "ok") return json(res, 403, { device: dev });
    req.deviceOK = true; // 본문을 읽을 때 서명한 본문 해시와 맞춰 본다
  }
  // 새 기기 승인 알림: 이미 허용된 폰이 기다리다가(최대 25초) 요청이 생기면 바로 받는다
  // 폰 알림: 새 기기 승인 + Claude 권한 요청. 아무것도 없으면 생길 때까지(최대 25초) 기다린다
  if (req.method === "GET" && url.pathname === "/approvals") {
    const snapshot = () => ({ pending: devices.pending(), permissions: permissions.list() });
    const now = snapshot();
    if (now.pending || now.permissions.length || url.searchParams.get("wait") !== "1") return json(res, 200, now);
    const stop = () => { clearTimeout(t); devices.events.off("change", done); permissions.events.off("change", done); };
    const done = () => { stop(); if (!res.writableEnded) json(res, 200, snapshot()); };
    const t = setTimeout(done, 25_000);
    devices.events.on("change", done);
    permissions.events.on("change", done);
    req.on("close", stop);
    return;
  }
  // 앱을 닫아도 오는 알림: 폰이 자기 푸시 번호를 알려 준다 (push.js)
  if (req.method === "POST" && url.pathname === "/push/register") {
    return withBody(req, res, (d) => json(res, push.register(String(req.headers["x-device-id"]), String(d.token || ""), d.env) ? 200 : 400, { ready: push.ready() }));
  }
  if (req.method === "POST" && url.pathname === "/push/activity") {
    return withBody(req, res, (d) => json(res, push.registerActivity(String(req.headers["x-device-id"]), String(d.team || ""), String(d.token || "")) ? 200 : 400, {}));
  }
  // 결과물 보기 (베이스캠프 안 파일만, files.js)
  if (req.method === "GET" && url.pathname === "/files/ticket") {
    const team = url.searchParams.get("team");
    const t = files.ticket(url.searchParams.get("path"), team ? teams.folderOf(team) : null);
    return t ? json(res, 200, { path: `/files/t/${t}` }) : json(res, 404, { error: "열 수 없는 파일입니다." });
  }
  if (req.method === "GET" && url.pathname === "/files") {
    const team = url.searchParams.get("team");
    return files.serve(req, res, url.searchParams.get("path"), team ? teams.folderOf(team) : null);
  }
  // 사용량 화면: 5시간·1주 한도(가장 최근 상태줄 기록)와 팀별 토큰
  if (req.method === "GET" && url.pathname === "/usage") {
    let limits = null;
    try {
      const dir = path.join(HOME, "statusline");
      const newest = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
      if (newest) limits = JSON.parse(fs.readFileSync(path.join(dir, newest.f), "utf8"));
    } catch {}
    return json(res, 200, { limits, teams: teams.usageAll(runningSet()) });
  }
  const pm = url.pathname.match(/^\/permissions\/([0-9a-f]{16})$/);
  if (req.method === "POST" && pm) {
    return withBody(req, res, (d) => {
      const ok = permissions.answer(pm[1], d.allow === true, devices.list().find((x) => x.id === req.headers["x-device-id"])?.name);
      json(res, ok ? 200 : 409, {});
    });
  }
  const ap = url.pathname.match(/^\/approvals\/([0-9a-f]{16})$/);
  if (req.method === "POST" && ap) {
    return withBody(req, res, (d) => {
      const ok = devices.answer(ap[1], d.allow === true, String(req.headers["x-device-id"] || ""));
      json(res, ok ? 200 : 409, {});
    });
  }
  if (req.method === "GET" && url.pathname === "/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(listSessions()));
  }
  if (req.method === "POST" && url.pathname === "/upload") {
    const chunks = []; let size = 0;
    // Cloudflare 무료 터널은 한 번에 100MB까지만 넘겨 준다
    req.on("data", (c) => { size += c.length; if (size > 95_000_000) return req.destroy(); chunks.push(c); });
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (req.deviceOK && !devices.bodyOK(req, buf)) return json(res, 400, { error: "본문이 서명과 다릅니다." });
      // 사진 JPEG(FF D8)·PNG(89 50), 영상 MP4·MOV(4번째 바이트부터 "ftyp", 상표가 "qt  "면 MOV)만 받는다
      const ftyp = buf.toString("latin1", 4, 8) === "ftyp";
      const ext = buf[0] === 0xff && buf[1] === 0xd8 ? "jpg" : buf[0] === 0x89 && buf[1] === 0x50 ? "png"
        : ftyp ? (buf.toString("latin1", 8, 12) === "qt  " ? "mov" : "mp4") : null;
      if (!ext) return json(res, 400, { error: "사진(JPEG·PNG)이나 영상(MP4·MOV)만 올릴 수 있습니다." });
      const kind = ftyp ? "video" : "photo";
      const dir = path.join(HOME, "uploads");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      const file = path.join(dir, `${kind}-${stamp}-${crypto.randomBytes(8).toString("hex")}.${ext}`);
      fs.writeFileSync(file, buf, { mode: 0o600 });
      json(res, 200, { path: file });
    });
    return;
  }
  const sm = url.pathname.match(/^\/sessions\/([^/]+)\/statusline$/);
  if (req.method === "GET" && sm && NAME_RE.test(sm[1])) {
    let usage;
    try { usage = JSON.parse(fs.readFileSync(path.join(HOME, "statusline", sm[1] + ".json"), "utf8")); } catch {}
    if (!usage) { res.writeHead(204); return res.end(); }
    return json(res, 200, usage);
  }
  const m = url.pathname.match(/^\/sessions\/(.+)$/);
  if (req.method === "DELETE" && m && NAME_RE.test(m[1])) {
    try { tmux(["kill-session", "-t", "=" + m[1]]); } catch {}
    res.writeHead(204); return res.end();
  }
  const am = url.pathname.match(/^\/agents(?:\/([^/]+))?$/);
  if (am) {
    let name;
    try { name = am[1] && decodeURIComponent(am[1]); } catch { return json(res, 400, {}); }
    return handleAgents(req, res, name);
  }
  if (req.method === "GET" && url.pathname === "/folders") return json(res, 200, teams.folders());
  // 이 Mac에 깔린 AI 도구 (새 창 기본 명령·팀원 도구 고르기)
  if (req.method === "GET" && url.pathname === "/tools") return require("./tools").list((l) => json(res, 200, l));
  if (req.method === "POST" && url.pathname === "/teams/plan") return withBody(req, res, (d) => teams.plan(d, (r) => reply(res, r)));
  const tm = url.pathname.match(/^\/teams(?:\/([^/]+))?(?:\/(start|stop|board|status|order|drawer))?$/);
  if (tm) return handleTeams(req, res, tm[1], tm[2]);
  res.writeHead(404); res.end();
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// JSON 본문을 읽어 fn(data)에 넘긴다
function withBody(req, res, fn) {
  const chunks = []; let size = 0;
  req.on("data", (c) => { size += c.length; if (size > 200_000) return req.destroy(); chunks.push(c); });
  req.on("end", () => {
    const buf = Buffer.concat(chunks);
    // 폰이 서명한 본문 해시와 다르면(가로채 바꾼 본문) 받지 않는다
    if (req.deviceOK && !devices.bodyOK(req, buf)) return json(res, 400, { error: "본문이 서명과 다릅니다." });
    const body = buf.toString("utf8");
    let data;
    try { data = JSON.parse(body || "{}"); } catch { return json(res, 400, { error: "JSON 형식이 아닙니다." }); }
    if (!data || typeof data !== "object" || Array.isArray(data)) return json(res, 400, { error: "JSON 객체가 아닙니다." });
    try { fn(data); } catch (e) {
      console.log(new Date().toISOString(), "요청 처리 오류", req.method, String(e && e.message).slice(0, 120));
      if (!res.headersSent) json(res, 400, {});
    }
  });
}

function handleAgents(req, res, name) {
  if (req.method === "GET" && !name) return json(res, 200, agents.list());
  if (req.method === "DELETE" && name) return json(res, agents.remove(name) ? 200 : 404, {});
  if (req.method === "PUT" && name) {
    return withBody(req, res, (data) => {
      const err = agents.save(name, data);
      json(res, err ? 400 : 200, err ? { error: err } : {});
    });
  }
  json(res, 405, {});
}

const runningSet = () => new Set(listSessions().map((s) => s.name));
// 지금 화면이 움직이는(일하는) 창. 팀 사무실의 "working"과 같은 기준(최근 6초 안에 바뀜)
function workingSet() {
  let out = "";
  try { out = tmux(["list-windows", "-a", "-F", "#{session_name}\t#{window_activity}"]); } catch { return new Set(); }
  const now = Date.now() / 1000;
  return new Set(out.trim().split("\n").map((l) => l.split("\t")).filter(([, a]) => now - Number(a) < 6).map(([n]) => n));
}
const reply = (res, r) => json(res, r.error ? 400 : 200, r);

function handleTeams(req, res, id, action) {
  if (!id) {
    if (req.method === "GET") return json(res, 200, teams.list(runningSet(), workingSet()));
    if (req.method === "POST") return withBody(req, res, (d) => reply(res, teams.create(d)));
    return json(res, 405, {});
  }
  if (action === "board" && req.method === "GET") {
    const b = teams.board(id);
    return b === null ? json(res, 404, {}) : json(res, 200, { board: b });
  }
  if (action === "drawer" && req.method === "GET") {
    const d = teams.drawerOf(id);
    return d ? json(res, 200, d) : json(res, 404, {});
  }
  if (action === "start" && req.method === "POST") return reply(res, teams.start(id, tmux, runningSet()));
  if (action === "stop" && req.method === "POST") return reply(res, teams.stop(id, tmux));
  if (action === "status" && req.method === "GET") {
    const st = teams.status(id, tmux);
    return st ? json(res, 200, st) : json(res, 404, {});
  }
  if (action === "order" && req.method === "POST") return withBody(req, res, (d) => reply(res, teams.order(id, d.text, tmux, runningSet(), d.kind)));
  if (!action && req.method === "PUT") return withBody(req, res, (d) => reply(res, teams.update(id, d, tmux, runningSet())));
  if (!action && req.method === "DELETE") return json(res, teams.remove(id, tmux) ? 200 : 404, {});
  json(res, 405, {});
}
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on("upgrade", (req, socket, head) => {
  let url;
  try { url = new URL(req.url, "http://x"); } catch { return socket.destroy(); }
  const session = url.searchParams.get("session") || "pt-main";
  const auth = url.pathname === "/term" && NAME_RE.test(session) ? checkAuth(req) : "bad";
  if (auth !== "ok") {
    socket.write(auth === "blocked" ? "HTTP/1.1 429 Too Many Requests\r\n\r\n" : "HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  if (devices.check(req, clientIP(req)) !== "ok") {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    console.log(new Date().toISOString(), "연결", clientIP(req), session);
    attach(ws, session, url.searchParams.get("new") === "1");
  });
});

const hosts = process.env.HOSTS ? process.env.HOSTS.split(",") : ["127.0.0.1", ...tailscaleAddrs()];
const listen = (port, h) => {
  const s = http.createServer(server.listeners("request")[0]);
  s.on("upgrade", (...a) => server.emit("upgrade", ...a));
  // 포트가 이미 쓰이고 있어도 서버 전체가 죽지 않게 (그 주소만 못 연다)
  s.on("error", (e) => console.log(new Date().toISOString(), "열지 못함", h, port, e.code));
  s.listen(port, h, () => console.log(`pocket-terminal: ws://${h}:${port}/term`));
};
for (const h of hosts) h === hosts[0] ? server.listen(PORT, h, () => console.log(`pocket-terminal: ws://${h}:${PORT}/term (창 = tmux 세션 pt-*)`)) : listen(PORT, h);
listen(TUNNEL_PORT, "127.0.0.1"); // cloudflared 전용 (tunnel.js)
if (process.env.TUNNEL !== "0") tunnel.start();
// 중계 서버 길 (PT_RELAY가 있을 때). 터미널은 attach와 같은 tmux 명령으로 연다
require("./relay").start({
  handle,
  spawn: (session, create) => pty.spawn(TMUX, tmuxOpen(session, create), {
    name: "xterm-256color", cols: 80, rows: 24, cwd: WORKDIR,
    env: { ...process.env, TERM: "xterm-256color", LANG: "ko_KR.UTF-8", LC_ALL: "ko_KR.UTF-8" },
  }),
});
// 팀장의 결재 요청·일 끝남을 폰에 알리고 잠금화면 진척 표시를 갱신한다 (teamwatch.js)
require("./teamwatch").start(tmux, runningSet);
