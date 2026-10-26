// 기기 승인: 토큰(QR)만으로는 들어올 수 없다. 처음 보는 폰이 연결하려 하면 이 컴퓨터에
// 터미널 창을 하나 새로 띄워 허용(y)·거절(n)을 묻고, 주인이 허용한 기기만 등록한다.
// QR이 새도 내가 허용하지 않으면 못 들어온다.
// 이미 허용한 폰이 앱을 켜 두고 있으면 그 폰에도 같은 요청이 알림으로 뜨고, 폰에서 수락·거절해도 된다.
// 폰은 기기마다 서명 열쇠 한 쌍을 만든다(개인키는 iPhone 보안 칩 안에만 있다). 등록 때는 공개키만 받고,
// 매 요청에는 "기기 번호·시각·받는 주소(Host)·메서드·경로"에 대한 서명을 받는다(X-Device-Id/-Pub/-Ts/-Sig).
// 받는 주소가 서명에 들어가므로, 가짜 서버(QR이 새어 주소록에 가짜 주소가 올라간 경우)가 받은 서명을
// 진짜 컴퓨터에 다시 써먹을 수 없다. 같은 서명은 한 번만 받는다. 예전 방식(열쇠 원문, hash만 있는 기록)은 받지 않는다
// → 예전에 허용한 폰은 한 번 다시 허용해야 한다.
// 승인 창과 폰에는 공개키에서 뽑은 같은 확인 번호(6자리)가 보인다. 둘이 같을 때만 허용한다.
//   node devices.js list            등록된 기기 목록
//   node devices.js remove <번호>   기기 하나 빼기 (번호 앞 몇 글자만 써도 됨)
//   node devices.js ask <요청번호>  승인 터미널 창에서 실행됨 (서버가 띄운다)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { EventEmitter } = require("events");
const readline = require("readline");
const { HOME, PORT, TUNNEL_PORT, readState } = require("./config");

const FILE = path.join(HOME, "devices.json");
const ASK = path.join(HOME, "ask");    // 승인 요청을 서버 ↔ 승인 창이 주고받는 곳
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

// 예전 방식(열쇠 해시만 있는) 기록은 읽지 않는다 → 그 기기는 새 기기로 다시 허용받는다
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")).filter((d) => d && d.pub); } catch { return []; } };
const save = (list) => fs.writeFileSync(FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
// 공개키(SPKI DER, base64) → 확인 번호 "123 456" (앱 Settings.swift DeviceIdentity.code와 같은 계산)
function codeOf(pub) {
  const n = crypto.createHash("sha256").update(Buffer.from(pub, "base64")).digest().readUInt32BE(0) % 1_000_000;
  const s = String(n).padStart(6, "0");
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}
const SKEW = 120;                       // 시각 차이 허용(초)
const seen = new Map();                 // 이미 받은 서명 → 버려도 되는 때 (다시 보내기 막기)
setInterval(() => { const now = Date.now(); for (const [k, t] of seen) if (t < now) seen.delete(k); }, 60_000).unref();
const asks = new Map();                 // 접속 위치 → [승인 창을 띄운 때들] (창 폭탄 막기)

let devices = load();
// devices.js remove 로 파일이 바뀌면 켜져 있는 서버도 바로 따른다
if (require.main !== module) fs.watchFile(FILE, { interval: 2000 }, () => { devices = load(); });
let asking = null;              // 지금 승인 창을 띄워 묻고 있는 기기 번호 (한 번에 하나만 묻는다)
let current = null;             // 지금 묻고 있는 요청 {nonce, id, name, from, at} (폰 알림용)
const events = new EventEmitter(); // 요청이 생기거나 끝나면 "change" (폰의 기다리는 요청을 깨운다)
events.setMaxListeners(0);
const denied = new Map();       // 기기 번호 → 다시 물어도 되는 때 (거절 10분, 시간 초과 1분)
const lastSeenWrite = new Map();

// 기기 이름: 화면에 그대로 찍히므로 제어문자(터미널 꾸미기 문자 포함)를 지운다
function headerName(req) {
  let n = "";
  try { n = decodeURIComponent(String(req.headers["x-device-name"] || "")); } catch {}
  return cleanName(n);
}
function cleanName(n) {
  return String(n || "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 40);
}

// 이 요청이 받아도 되는 주소(Host)인가. 터널 포트는 지금 터널 주소만, 직접 포트는 들어온 그 주소(127.0.0.1, Tailscale)만.
// 그래서 가짜 서버에서 모은 서명(Host=가짜 주소)을 이 컴퓨터의 어느 포트에도 다시 쓸 수 없다.
let stateCache = { at: 0, host: "" };
function tunnelHost() {
  if (Date.now() - stateCache.at > 3000) {
    let host = "";
    try { host = new URL(readState().url || "").host; } catch {}
    stateCache = { at: Date.now(), host };
  }
  return stateCache.host;
}
function hostOK(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (req.socket.localPort === TUNNEL_PORT) return !!host && host === tunnelHost();
  const local = String(req.socket.localAddress || "").replace(/^::ffff:/, "");
  return host === `${local}:${PORT}` || (local === "127.0.0.1" && host === `localhost:${PORT}`);
}

// 서명 확인. 맞으면 공개키(base64), 아니면 null
// 서명 글: "pocket-terminal/2\n기기 번호\n초\n일회용 번호\nHost\n메서드 경로?쿼리\n본문 SHA256" (앱 Settings.swift request와 같다)
// 다시 보내기는 서명 글자가 아니라 (기기 번호, 일회용 번호)로 막는다 (base64 모양 바꾸기·ECDSA 서명 변형으로 우회 못 하게)
function verify(req, id) {
  const pub = String(req.headers["x-device-pub"] || "");
  const sig = String(req.headers["x-device-sig"] || "");
  const tsRaw = String(req.headers["x-device-ts"] || "");
  const nonce = String(req.headers["x-device-nonce"] || "");
  const body = String(req.headers["x-device-body"] || "");
  if (!/^[A-Za-z0-9+/]{80,200}={0,2}$/.test(pub) || !/^[A-Za-z0-9+/]{40,200}={0,2}$/.test(sig)) return null;
  if (!/^\d{10}$/.test(tsRaw) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(body)) return null;
  const ts = Number(tsRaw);
  if (Math.abs(Date.now() / 1000 - ts) > SKEW) return null;
  if (!hostOK(req)) { console.log(new Date().toISOString(), "받지 않는 주소로 온 요청", String(req.headers.host || "").slice(0, 80)); return null; }
  const once = `${id}:${nonce}`;
  if (seen.has(once)) return null;
  const msg = `pocket-terminal/2\n${id}\n${tsRaw}\n${nonce}\n${String(req.headers.host || "")}\n${req.method} ${req.url}\n${body}`;
  let ok = false;
  try {
    const der = Buffer.from(pub, "base64");
    if (der.toString("base64") !== pub) return null;   // 정해진 모양의 base64만
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    ok = key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      && crypto.verify("sha256", Buffer.from(msg), key, Buffer.from(sig, "base64"));
  } catch {}
  if (!ok) { console.log(new Date().toISOString(), "기기 서명 불일치", id.slice(0, 8)); return null; }
  seen.set(once, Date.now() + SKEW * 2000);
  return pub;
}

// 본문이 서명한 해시와 같은가 (서명 확인을 통과한 요청의 본문을 읽은 뒤 server.js가 부른다)
function bodyOK(req, buf) {
  return crypto.createHash("sha256").update(buf).digest("hex") === String(req.headers["x-device-body"] || "");
}

// "ok" | "pending" | "denied" | "missing"
function check(req, from) {
  const id = String(req.headers["x-device-id"] || "");
  if (!ID_RE.test(id)) return "missing";
  const pub = verify(req, id);
  if (!pub) return "missing";
  return decide(id, pub, headerName(req) || "이름 없는 기기", from);
}

// 서명을 확인한 기기를 허용·승인 대기·거절로 가른다 (터널 요청과 중계 연결이 같이 쓴다)
function decide(id, pub, name, from) {
  if (!ID_RE.test(id)) return "missing";
  const d = devices.find((x) => x.id === id && x.pub);
  if (d) {
    if (d.pub !== pub) return "denied";
    // 마지막 접속 시각은 10분에 한 번만 파일에 쓴다
    const now = Date.now();
    if (now - (lastSeenWrite.get(id) || 0) > 10 * 60_000) { d.lastSeen = now; lastSeenWrite.set(id, now); save(devices); }
    return "ok";
  }
  const until = denied.get(id);
  if (until && Date.now() < until) return "denied";
  if (asking) return "pending";
  // 한 접속 위치에서 10분에 승인 창 3번까지 (모르는 기기가 창을 계속 띄워 주인을 지치게 하는 것 막기)
  const now = Date.now();
  const recent = (asks.get(from) || []).filter((t) => now - t < 10 * 60_000);
  if (recent.length >= 3) return "denied";
  asks.set(from, [...recent, now]);
  if (asks.size > 1000) asks.delete(asks.keys().next().value);
  ask(id, pub, cleanName(name) || "이름 없는 기기", from);
  return "pending";
}

// 터미널 창을 새로 띄워 묻는다. 1분 안에 답하지 않으면 자동으로 거절한다.
// 서버는 요청 내용을 ask/<요청번호>.json 에 쓰고, 승인 창이 ask/<요청번호>.answer 에 allow·deny를 쓴다.
// 허용되면 공개키를 저장한다 (공개키는 새어도 상관없다).
function ask(id, pub, name, from) {
  asking = id;
  const nonce = crypto.randomBytes(8).toString("hex");
  const code = codeOf(pub);
  current = { nonce, id, name, from, code, at: Date.now() };
  events.emit("change");
  const base = path.join(ASK, nonce);
  fs.mkdirSync(ASK, { recursive: true, mode: 0o700 });
  fs.writeFileSync(base + ".json", JSON.stringify({ id, name, from, code, at: Date.now() }), { mode: 0o600 });
  const sq = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'"; // 셸 작은따옴표 감싸기
  // 답하면(또는 시간이 지나면) 결과를 잠깐 보여 주고 창이 저절로 닫힌다
  fs.writeFileSync(base + ".command", ["#!/bin/bash", `${sq(process.execPath)} ${sq(__filename)} ask ${nonce}`,
    `rm -f -- "$0"`, ...require("./config").closeWindowLines()].join("\n") + "\n", { mode: 0o700 });
  console.log(new Date().toISOString(), "기기 승인 요청", name, id.slice(0, 8), from);
  // 앱을 닫아 둔 폰에도 알린다 (잠금화면에서 [수락] [거절])
  require("./push").notify({ title: "누군가 연결을 시도합니다", body: `${name} · 확인 번호 ${code}. 내가 찍은 기기가 아니면 거절하세요.`,
    category: "DEVICE", data: { nonce }, except: id, collapse: `dev-${nonce}` });
  execFile("/usr/bin/open", [base + ".command"]);
  execFile("/usr/bin/afplay", ["/System/Library/Sounds/Glass.aiff"], () => {});

  const started = Date.now();
  const timer = setInterval(() => {
    let answer = null;
    try { answer = fs.readFileSync(base + ".answer", "utf8").trim(); } catch {}
    if (!answer && Date.now() - started < 60_000) return;
    clearInterval(timer);
    for (const ext of [".json", ".answer"]) fs.rmSync(base + ext, { force: true }); // .command는 창이 끝나며 스스로 지운다
    asking = null;
    current = null;
    events.emit("change");
    if (answer === "allow") {
      devices = devices.filter((d) => d.id !== id); // 예전 방식 기록은 바꿔 끼운다
      devices.push({ id, name, pub, added: Date.now(), lastSeen: Date.now() });
      save(devices);
      events.emit("allowed", id);
      console.log(new Date().toISOString(), "기기 허용", name, id.slice(0, 8));
    } else {
      denied.set(id, Date.now() + (answer ? 10 : 1) * 60_000);
      console.log(new Date().toISOString(), "기기 거절", name, id.slice(0, 8), answer ? "" : "(시간 초과)");
    }
  }, 1000);
}

// 폰 알림용: 지금 묻고 있는 요청 (열쇠·전체 기기 번호는 내보내지 않는다)
function pending() {
  if (!current) return null;
  const { nonce, id, name, from, code, at } = current;
  return { nonce, device: id.slice(0, 8), name, from, code, at, expires: at + 60_000 };
}

// 이미 허용된 폰이 앱 알림에서 수락·거절. 컴퓨터 승인 창과 같은 답 파일을 쓴다. 자기 자신은 승인할 수 없다.
function answer(nonce, allow, byId) {
  if (!current || current.nonce !== nonce || current.id === byId) return false;
  const base = path.join(ASK, nonce);
  if (fs.existsSync(base + ".answer")) return false;
  fs.writeFileSync(base + ".answer", allow ? "allow" : "deny", { mode: 0o600 });
  const by = devices.find((d) => d.id === byId);
  console.log(new Date().toISOString(), "폰에서 답함", by ? by.name : "?", allow ? "수락" : "거절");
  return true;
}

// 승인 터미널 창: 요청 내용을 보여 주고 y/n을 받는다
function askPrompt(nonce) {
  const base = path.join(ASK, String(nonce).replace(/[^0-9a-f]/g, ""));
  let req;
  try { req = JSON.parse(fs.readFileSync(base + ".json", "utf8")); } catch {
    console.log("이미 끝났거나 시간이 지난 요청입니다. 이 창은 닫아도 됩니다.");
    return;
  }
  const left = Math.max(0, Math.round((req.at + 60_000 - Date.now()) / 1000));
  console.log("\n  포켓 터미널 - 새 기기 연결 요청\n");
  console.log(`  확인 번호  ${req.code}`);
  console.log(`  기기       ${req.name}`);
  console.log(`  접속 IP    ${req.from}  (인터넷 주소. 위치 정보가 아니라 대략적인 지역만 알 수 있다)`);
  console.log("\n  이 기기가 이 컴퓨터의 터미널을 쓰려고 합니다.");
  console.log("  폰 화면의 확인 번호가 위 번호와 같을 때만 허용하세요.");
  console.log("  내가 방금 QR을 찍은 기기가 아니면 거절하세요. 연결 QR이 샌 것일 수 있으니 pt.sh reset 으로 새로 만드세요.");
  console.log(`  ${left}초 안에 답하지 않으면 거절됩니다.\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const done = (msg) => { console.log("\n  " + msg + "\n  이 창은 곧 저절로 닫힙니다.\n"); rl.close(); process.exit(0); };
  setTimeout(() => done("시간이 지나 거절되었습니다."), left * 1000);
  // 폰 알림에서 먼저 답하면 서버가 요청 파일을 지운다 → 이 창도 끝낸다
  setInterval(() => {
    if (fs.existsSync(base + ".json")) return;
    process.stdout.write("\n");
    done("휴대폰에서 이미 답했습니다.");
  }, 1000);
  const q = () => rl.question("  허용하려면 y, 거절하려면 n 을 누르고 Enter: ", (a) => {
    const v = a.trim().toLowerCase();
    // 한글 자판 상태에서 누른 y(ㅛ)·n(ㅜ)도 받는다
    const yes = ["y", "yes", "ㅛ", "허용"].includes(v), no = ["n", "no", "ㅜ", "거절"].includes(v);
    if (!yes && !no) return q();
    if (!fs.existsSync(base + ".json")) return done("이미 시간이 지난 요청입니다.");
    fs.writeFileSync(base + ".answer", yes ? "allow" : "deny", { mode: 0o600 });
    done(yes ? "허용했습니다. 폰이 곧 연결됩니다." : "거절했습니다.");
  });
  q();
}

// 지금 들어올 수 있는 기기 (예전 방식으로 허용돼 다시 허용해야 하는 기기는 빠진다)
function list() { return devices.filter((d) => d.pub).map(({ id, name, added, lastSeen }) => ({ id, name, added, lastSeen })); }

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  const day = (t) => (t ? new Date(t).toLocaleString("ko-KR") : "-");
  if (cmd === "list") {
    if (!devices.length) console.log("등록된 기기가 없습니다.");
    for (const d of devices) console.log(`${d.id.slice(0, 8)}  ${d.name}  등록 ${day(d.added)}  마지막 ${day(d.lastSeen)}`);
  } else if (cmd === "ask" && arg) {
    askPrompt(arg);
  } else if (cmd === "remove" && arg) {
    const hit = devices.filter((d) => d.id.startsWith(arg));
    if (hit.length !== 1) { console.log(hit.length ? "여러 기기가 맞습니다. 번호를 더 길게 써 주세요." : "그런 기기가 없습니다."); process.exit(1); }
    save(devices.filter((d) => d !== hit[0]));
    require("./push").drop(hit[0].id);
    console.log(`뺐습니다: ${hit[0].name} (${hit[0].id.slice(0, 8)}). 바로 적용됩니다.`);
  } else {
    console.log("사용: node devices.js list | remove <번호>");
  }
}

// 중계 방에 올릴 허용 기기 목록: 공개키 SPKI의 SHA256 base64url (중계는 이 가명만 안다)
function allowHashes() {
  return devices.filter((d) => d.pub).map((d) => crypto.createHash("sha256").update(Buffer.from(d.pub, "base64")).digest("base64url"));
}
const codeFor = codeOf;

module.exports = { check, decide, bodyOK, list, pending, answer, events, allowHashes, codeFor };
