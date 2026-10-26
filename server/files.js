// 결과물 보기: 팀 대화방에 나온 파일 경로("ep02/대본.md", "failed-company-lab/ep02/썸네일.png")를 앱에서 열게 한다.
// 베이스캠프(WORKDIR)와 외장하드의 베이스캠프(/Volumes/<이름>/클로드 전용 폴더, 완성본이 여기 저장된다) 안의 파일만 연다.
// 비밀 폴더(API키 보관)와 숨김 파일(.env, .git 등)은 열지 않는다.
//   GET /files?path=<경로>&team=<팀 id>  → 글이면 {kind:"text", text}, 그림·영상·PDF면 파일 그대로(영상은 Range 지원)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WORKDIR } = require("./config");

const TYPES = {
  ".md": "text", ".txt": "text", ".json": "text", ".csv": "text", ".srt": "text", ".vtt": "text", ".yml": "text", ".yaml": "text",
  ".html": "text", ".js": "text", ".ts": "text", ".py": "text", ".sh": "text", ".swift": "text", ".css": "text", ".log": "text",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
  ".pdf": "application/pdf",
};
const MAX_TEXT = 2 * 1024 * 1024;

// 열어도 되는 곳: 베이스캠프 + 지금 꽂혀 있는 외장하드의 베이스캠프
function roots() {
  const out = [WORKDIR];
  try {
    for (const v of fs.readdirSync("/Volumes")) {
      const r = path.join("/Volumes", v, path.basename(WORKDIR));
      if (fs.existsSync(r)) out.push(r);
    }
  } catch {}
  return out.map((r) => { try { return fs.realpathSync(r); } catch { return null; } }).filter(Boolean);
}

// 글 속 경로를 실제 파일로. 후보: 절대·~ 경로, 팀 폴더 기준, 베이스캠프 기준. 열어도 되는 곳 밖이면 null
function resolve(raw, teamFolder) {
  let p = String(raw || "").trim().replace(/^["'`(]+|["'`),.]+$/g, "");
  if (!p) return null;
  if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  // 상대 경로는 팀 폴더 → 베이스캠프 → 베이스캠프 바로 아래 폴더들("ep02/대본.md" → failed-company-lab/ep02/대본.md) 순서로 찾는다
  let tops = [];
  try { tops = fs.readdirSync(WORKDIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => path.join(WORKDIR, d.name, p)); } catch {}
  const cands = path.isAbsolute(p) ? [p] : [teamFolder && path.join(teamFolder, p), path.join(WORKDIR, p), ...tops].filter(Boolean);
  const allowed = roots();
  for (const c of cands) {
    let real;
    try { real = fs.realpathSync(c); } catch { continue; }
    const rel = allowed.map((r) => path.relative(r, real)).find((x) => !x.startsWith("..") && !path.isAbsolute(x));
    if (rel === undefined) continue;
    // 비밀·숨김은 막는다
    if (rel.split(path.sep).some((s) => s.startsWith(".") || /API ?키|api[ _-]?keys?|secret|credential|password|비밀번호/i.test(s))) continue;
    if (!fs.statSync(real).isFile()) continue;
    return real;
  }
  return null;
}

// 영상·소리 재생용 표: 파일 하나, 10분
const tickets = new Map(); // 표 → { file, until }
function ticket(raw, teamFolder) {
  const file = resolve(raw, teamFolder);
  if (!file || !TYPES[path.extname(file).toLowerCase()]) return null;
  const now = Date.now();
  for (const [k, v] of tickets) if (v.until < now) tickets.delete(k);
  if (tickets.size > 200) tickets.delete(tickets.keys().next().value);
  const t = require("crypto").randomBytes(32).toString("hex");
  tickets.set(t, { file, until: now + 10 * 60_000 });
  return t;
}
function serveTicket(req, res, t) {
  const v = tickets.get(t);
  if (!v || v.until < Date.now()) { res.writeHead(404); return res.end(); }
  return send(req, res, v.file);
}

function serve(req, res, raw, teamFolder) {
  return send(req, res, resolve(raw, teamFolder));
}

function send(req, res, file) {
  const type = file && TYPES[path.extname(file).toLowerCase()];
  if (!file || !type) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "열 수 없는 파일입니다." }));
  }
  const size = fs.statSync(file).size;
  const name = path.basename(file);
  if (type === "text") {
    if (size > MAX_TEXT) { res.writeHead(413); return res.end(); }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ kind: "text", name, text: fs.readFileSync(file, "utf8") }));
  }
  // 영상·소리는 앞으로 감기·건너뛰기 때문에 일부만 달라고(Range) 한다
  const m = String(req.headers.range || "").match(/^bytes=(\d*)-(\d*)$/);
  const head = { "Content-Type": type, "Accept-Ranges": "bytes", "X-File-Name": encodeURIComponent(name) };
  if (m && size) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || end < start) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...head, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    return stream(fs.createReadStream(file, { start, end }), res);
  }
  res.writeHead(200, { ...head, "Content-Length": size });
  stream(fs.createReadStream(file), res);
}

// 읽다가 오류가 나도(권한 없음 등) 서버가 죽지 않게
function stream(s, res) {
  s.on("error", () => res.destroy());
  s.pipe(res);
}

module.exports = { serve, serveTicket, ticket, resolve };
