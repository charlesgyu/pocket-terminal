// 앱을 닫아도 오는 알림 (Apple 푸시, APNs).
// 앱이 켜질 때 자기 푸시 번호를 POST /push/register 로 알려 주면 여기 적어 두고, 일이 생기면 Apple 서버로 보낸다.
//   새 기기 승인 요청  → [수락] [거절] 버튼 (category DEVICE)
//   Claude 권한 요청   → [허용] [거절] 버튼 (category PERM)
//   팀장의 결재 요청   → 누르면 그 팀 사무실 (category TEAM)
//   팀 진척률이 바뀜   → 잠금화면 진척 표시(라이브 액티비티) 갱신
// 필요한 것: ~/.pocket-terminal/apns.json {"keyId","teamId","keyFile"} 와 Apple 개발자 사이트에서 받은 .p8 열쇠 파일.
// 없으면 아무 것도 보내지 않는다 (앱이 켜져 있을 때의 알림은 그대로 된다).
const fs = require("fs");
const path = require("path");
const http2 = require("http2");
const crypto = require("crypto");
const { HOME } = require("./config");

const TOPIC = "com.charles.pocketterminal";
const CONF = path.join(HOME, "apns.json");
const TOKENS = path.join(HOME, "push.json"); // 기기 번호 → { token, env, activity: {팀 id: 라이브 액티비티 푸시 번호} }

const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const save = (o) => fs.writeFileSync(TOKENS, JSON.stringify(o, null, 2), { mode: 0o600 });

function config() {
  const c = load(CONF, null);
  if (!c || !c.keyId || !c.teamId || !c.keyFile) return null;
  try { return { ...c, key: fs.readFileSync(c.keyFile.replace(/^~/, require("os").homedir()), "utf8") }; } catch { return null; }
}

// Apple이 요구하는 서명 토큰 (ES256 JWT). 20~60분마다 새로 만들어야 해서 50분 동안만 재사용한다
let jwt = { value: null, at: 0 };
function bearer(c) {
  if (jwt.value && Date.now() - jwt.at < 50 * 60_000) return jwt.value;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "ES256", kid: c.keyId });
  const body = b64({ iss: c.teamId, iat: Math.floor(Date.now() / 1000) });
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key: c.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  jwt = { value: `${head}.${body}.${sig}`, at: Date.now() };
  return jwt.value;
}

const sessions = {}; // env → http2 연결 (Apple은 연결을 계속 열어 두고 쓰기를 권한다)
function client(env) {
  const host = env === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
  let s = sessions[env];
  if (!s || s.closed || s.destroyed) {
    s = sessions[env] = http2.connect(host);
    s.on("error", () => { delete sessions[env]; });
    s.on("goaway", () => { delete sessions[env]; });
    s.unref();
  }
  return s;
}

function send(token, env, payload, { type = "alert", topic = TOPIC, priority = 10, collapse } = {}) {
  const c = config();
  if (!c) return;
  const headers = {
    ":method": "POST", ":path": `/3/device/${token}`,
    authorization: `bearer ${bearer(c)}`, "apns-topic": topic, "apns-push-type": type, "apns-priority": String(priority),
  };
  if (collapse) headers["apns-collapse-id"] = collapse;
  try {
    const req = client(env).request(headers);
    let out = "";
    req.on("response", (h) => {
      req.on("data", (d) => (out += d));
      req.on("end", () => {
        const code = h[":status"];
        if (code === 200) return;
        console.log(new Date().toISOString(), "푸시 실패", code, out);
        // 앱을 지웠거나 번호가 바뀌면 410/400 BadDeviceToken → 그 번호는 지운다
        if (code === 410 || /BadDeviceToken|Unregistered/.test(out)) forget(token);
      });
    });
    req.on("error", () => {});
    req.end(JSON.stringify(payload));
  } catch (e) { console.log(new Date().toISOString(), "푸시 연결 실패", e.message); }
}

function register(deviceId, token, env) {
  if (!/^[0-9a-f]{32,200}$/i.test(token)) return false;
  const all = load(TOKENS, {});
  all[deviceId] = { ...(all[deviceId] || {}), token, env: env === "production" ? "production" : "development" };
  save(all);
  return true;
}

function registerActivity(deviceId, team, token) {
  if (!/^[0-9a-f]{32,400}$/i.test(token) || !/^t[a-z0-9]{4,12}$/.test(team)) return false;
  const all = load(TOKENS, {});
  if (!all[deviceId]) return false;
  all[deviceId].activity = { ...(all[deviceId].activity || {}), [team]: token };
  save(all);
  return true;
}

function forget(token) {
  const all = load(TOKENS, {});
  for (const [id, d] of Object.entries(all)) {
    if (d.token === token) delete all[id];
    else if (d.activity) for (const [t, a] of Object.entries(d.activity)) if (a === token) delete d.activity[t];
  }
  save(all);
}

// 지금 허용된 기기만 (목록에서 뺀 폰, 다시 허용해야 하는 폰에는 보내지 않는다)
const allowed = () => new Set(require("./devices").list().map((d) => d.id));

// 허용된 모든 폰에 알림. except: 이 기기에는 보내지 않는다 (승인을 요청한 기기 자신)
function notify({ title, body, category, data = {}, except, collapse, sound = "default" }) {
  const ok = allowed();
  for (const [id, d] of Object.entries(load(TOKENS, {}))) {
    if (id === except || !d.token || !ok.has(id)) continue;
    send(d.token, d.env, {
      aps: { alert: { title, body }, sound, category, "interruption-level": "time-sensitive", "thread-id": category },
      ...data,
    }, { collapse });
  }
}

// 잠금화면 진척 표시(라이브 액티비티) 갱신. state는 앱의 TeamActivity.ContentState 모양 그대로
function updateActivity(team, state, end = false) {
  const ok = allowed();
  for (const [id, d] of Object.entries(load(TOKENS, {}))) {
    if (!ok.has(id)) continue;
    const token = d.activity && d.activity[team];
    if (!token) continue;
    const now = Math.floor(Date.now() / 1000);
    send(token, d.env, { aps: { timestamp: now, event: end ? "end" : "update", "content-state": state, ...(end ? { "dismissal-date": now + 3600 } : {}) } },
      { type: "liveactivity", topic: `${TOPIC}.push-type.liveactivity`, priority: 5 });
  }
}

const ready = () => !!config();

// 기기를 목록에서 뺄 때 그 폰의 푸시 번호도 지운다
function drop(id) {
  const all = load(TOKENS, {});
  if (id in all) { delete all[id]; save(all); }
}

module.exports = { register, registerActivity, notify, updateActivity, ready, drop };
