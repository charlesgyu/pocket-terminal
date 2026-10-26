// Mac ↔ 중계 서버 (docs/relay-design.md 10절). Cloudflare 임시 터널 대신 쓰는 길.
// Mac이 켜지면 중계의 자기 방에 붙어 기다린다. 폰이 들어오면 Noise NKpsk2로 끝에서 끝 암호를 맺고,
// 폰 보안 칩 서명으로 기기를 확인한 뒤(처음 보는 기기는 지금처럼 승인 창), 요청·터미널을 서버 안에서 직접 처리한다.
// 127.0.0.1의 HTTP로 다시 들어가지 않는다: 허용 목록에 있는 경로만 handle()에 req.relay 표시를 붙여 넘긴다.
// 열쇠: relay-key.pem(방 주인 P-256 서명), noise-key(X25519). 둘 다 ~/.pocket-terminal, 600.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Writable } = require("stream");
const { EventEmitter } = require("events");
const { Handshake, keyPair } = require("./noise");
const devices = require("./devices");
const { HOME, token } = require("./config");

// 포켓 터미널 중계 서버 (relay/, Cloudflare). 시험할 때만 PT_RELAY로 바꾼다
const RELAY = (process.env.PT_RELAY || "https://pocket-relay.contentsb.workers.dev").replace(/\/$/, "");
const te = (s) => Buffer.from(s, "utf8");
const BUCKETS = [256, 1024, 4096, 16384, 65519];
const MAX_BODY_CHUNK = 32 * 1024; // base64로 바꾸면 약 44KB → 평문 칸(65519) 안에 들어간다

// 허용 경로 (폰 앱이 쓰는 것만). /hook/permission, /files/t/*, /term은 없다. 응답은 20MB까지(큰 영상은 구간으로)
const ROUTES = [
  ["GET", /^\/sessions$/], ["DELETE", /^\/sessions\/pt-[A-Za-z0-9_-]{1,32}$/], ["GET", /^\/sessions\/pt-[A-Za-z0-9_-]{1,32}\/statusline$/],
  ["GET", /^\/approvals$/], ["POST", /^\/approvals\/[0-9a-f]{16}$/], ["POST", /^\/permissions\/[0-9a-f]{16}$/],
  ["POST", /^\/push\/(register|activity)$/],
  ["GET", /^\/files$/], ["GET", /^\/files\/ticket$/], ["GET", /^\/usage$/], ["GET", /^\/folders$/], ["GET", /^\/tools$/],
  ["POST", /^\/upload$/],
  ["GET", /^\/agents$/], ["PUT", /^\/agents\/[a-z0-9][a-z0-9-]{0,47}$/], ["DELETE", /^\/agents\/[a-z0-9][a-z0-9-]{0,47}$/],
  ["GET", /^\/teams$/], ["POST", /^\/teams$/], ["POST", /^\/teams\/plan$/],
  ["GET", /^\/teams\/t[a-z0-9]{4,12}\/(board|status|drawer)$/], ["POST", /^\/teams\/t[a-z0-9]{4,12}\/(start|stop|order)$/],
  ["PUT", /^\/teams\/t[a-z0-9]{4,12}$/], ["DELETE", /^\/teams\/t[a-z0-9]{4,12}$/],
];
// 경로는 "/글자" 모양만. 점 세그먼트·%2e·역슬래시·이중 슬래시는 거절 (경로 조작·SSRF 막기)
function allowed(method, target) {
  if (typeof target !== "string" || target.length > 2048 || !/^\/[^/\\]/.test(target)) return false;
  const p = target.split("?")[0];
  if (/(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\|\/\//i.test(p)) return false;
  return ROUTES.some(([m, re]) => m === method && re.test(p));
}

// ── 열쇠 ─────────────────────────────────────────
function secret(name, make) {
  const f = path.join(HOME, name);
  if (!fs.existsSync(f)) fs.writeFileSync(f, make(), { mode: 0o600 });
  return fs.readFileSync(f);
}
function keys() {
  const pem = secret("relay-key.pem", () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })).toString();
  const roomKey = crypto.createPrivateKey(pem);
  const roomPub = crypto.createPublicKey(roomKey).export({ type: "spki", format: "der" });
  const noise = keyPair(secret("noise-key", () => crypto.randomBytes(32)).subarray(0, 32));
  const room = crypto.createHash("sha256").update(Buffer.concat([te("pocket-room/1"), roomPub])).digest("base64url");
  return { roomKey, roomPub, noise, room };
}
const pskOf = (tok) => crypto.createHash("sha256").update(Buffer.concat([te("pocket-terminal/psk/1"), te(tok)])).digest();
const prologue = (k) => Buffer.concat([te("pocket-terminal/relay/1"), te(k.room), k.roomPub, k.noise.pub]);

// QR 2판 링크 (pair.js가 그린다)
function pairLink(name) {
  const k = keys();
  return "pocketterminal://pair?" + new URLSearchParams({
    v: "2", relay: RELAY, room: k.room, rk: k.roomPub.toString("base64url"), nk: k.noise.pub.toString("base64url"),
    psk: token(), name,
  });
}

// ── 평문 틀: [종류][길이 u32][본문][0 채움] (길이를 정해진 칸으로 맞춰 내용 길이를 감춘다) ─────
function frame(kind, body) {
  const need = 5 + body.length;
  const size = BUCKETS.find((b) => b >= need);
  if (!size) throw new Error("frame too big");
  const out = Buffer.alloc(size);
  out[0] = kind; out.writeUInt32BE(body.length, 1); body.copy(out, 5);
  return out;
}
function unframe(pt) {
  if (pt.length < 5 || !BUCKETS.includes(pt.length)) throw new Error("bad frame");
  const len = pt.readUInt32BE(1);
  if (5 + len > pt.length) throw new Error("bad frame");
  return { kind: pt[0], body: pt.subarray(5, 5 + len) };
}

// ── 폰 연결 하나 ─────────────────────────────────
class Peer {
  constructor(link, conn, pairing) {
    this.link = link; this.conn = conn; this.pairing = pairing;
    this.hs = new Handshake({ initiator: false, prologue: prologue(link.k), s: link.k.noise, psk: pskOf(token()) });
    this.state = "handshake"; // handshake → auth → (pending) → ready
    this.terms = new Map();   // 창 번호 → { term, buf, timer }
    this.reqs = 0;
    this.uploads = new Map(); // 요청 번호 → 지금까지 받은 본문 조각 (큰 업로드는 more:true로 나눠 온다)
  }

  send(kind, body) {
    if (!this.tx) return;
    const ct = this.tx.encrypt(Buffer.alloc(0), frame(kind, body));
    this.link.toPhone(this.conn, ct);
  }
  json(o) { this.send(1, te(JSON.stringify(o))); }

  fail(why) {
    if (this.state === "dead") return;
    console.log(new Date().toISOString(), "중계 연결 끊음", this.conn, why);
    this.close();
    this.link.kick(this.conn);
  }
  close() {
    this.state = "dead";
    for (const t of this.terms.values()) { clearTimeout(t.timer); try { t.term.kill(); } catch {} }
    this.terms.clear();
    this.hs = this.tx = this.rx = null;
  }

  onMessage(buf) {
    try {
      if (this.state === "handshake") {
        this.hs.read(buf);
        const reply = this.hs.write();
        const { hash, send, recv } = this.hs.split();
        this.hash = hash; this.tx = send; this.rx = recv; this.state = "auth";
        this.link.toPhone(this.conn, reply);
        return;
      }
      const { kind, body } = unframe(this.rx.decrypt(Buffer.alloc(0), buf));
      if (kind === 1) return this.onJSON(JSON.parse(body.toString("utf8")));
      if (kind === 2 && this.state === "ready") return this.onInput(body);
      throw new Error("bad kind");
    } catch (e) {
      this.fail(String(e && e.message).slice(0, 60));
    }
  }

  onJSON(m) {
    if (this.state === "auth") {
      if (m.t !== "auth" || typeof m.id !== "string" || typeof m.pub !== "string" || typeof m.sig !== "string") throw new Error("auth");
      // 폰 보안 칩 서명이 이 연결의 핸드셰이크 해시에 묶였는지
      const spki = Buffer.from(m.pub, "base64");
      const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
      if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("auth");
      const ok = crypto.verify("sha256", Buffer.concat([te("pocket-relay/1 phone-auth"), this.hash]), key, Buffer.from(m.sig, "base64"));
      if (!ok) throw new Error("auth");
      this.device = { id: m.id, pub: spki.toString("base64"), name: String(m.name || "") };
      this.state = "pending";
      return this.decide();
    }
    if (this.state !== "ready") throw new Error("not ready");
    if (m.t === "req") return this.onReq(m);
    if (m.t === "open") return this.onOpen(m);
    if (m.t === "resize") { const t = this.terms.get(m.sid); if (t && m.c > 0 && m.r > 0) t.term.resize(Math.min(m.c, 500), Math.min(m.r, 200)); return; }
    if (m.t === "close") { const t = this.terms.get(m.sid); if (t) { try { t.term.kill(); } catch {} } return; }
    throw new Error("unknown");
  }

  // 허용된 기기면 ready, 처음 보는 기기면 승인 창(확인 번호), 거절이면 끊는다
  decide() {
    const d = this.device;
    // 승인 창 횟수 제한(10분에 3번)은 중계로 오는 연결을 하나로 묶어 센다 (연결 번호는 매번 새로 붙어 따로 세면 제한이 안 걸린다)
    const r = devices.decide(d.id, d.pub, d.name, "중계");
    if (r === "ok") {
      this.state = "ready";
      if (this.pairing) this.link.promote(this.conn);
      this.link.sendAllow();
      return this.json({ t: "ready" });
    }
    if (r === "pending") {
      this.json({ t: "pending", code: devices.codeFor(d.pub) });
      const onAllowed = (id) => { if (id === d.id && this.state === "pending") { devices.events.off("allowed", onAllowed); this.decide(); } };
      devices.events.on("allowed", onAllowed);
      setTimeout(() => { devices.events.off("allowed", onAllowed); if (this.state === "pending") this.fail("approval timeout"); }, 70_000);
      return;
    }
    this.json({ t: "denied" });
    setTimeout(() => this.fail("denied"), 200);
  }

  async onReq(m) {
    const id = m.id, method = String(m.method || "GET").toUpperCase();
    if (!Number.isInteger(id)) throw new Error("req");
    if (!allowed(method, m.path)) { this.uploads.delete(id); return this.json({ t: "res", id, status: 403, body: "", more: false }); }
    // 본문 조각을 모은다. 큰 업로드(사진·영상)는 {more:true} 여러 개로 나눠 온다
    const part = typeof m.body === "string" ? Buffer.from(m.body, "base64") : Buffer.alloc(0);
    const got = this.uploads.get(id) || { parts: [], size: 0 };
    got.parts.push(part); got.size += part.length;
    if (got.size > 95_000_000 || this.uploads.size > 4) { this.uploads.delete(id); return this.json({ t: "res", id, status: 413, body: "", more: false }); }
    if (m.more === true) { this.uploads.set(id, got); return; }
    this.uploads.delete(id);
    if (++this.reqs > 100_000) throw new Error("too many requests");
    // 넘겨도 되는 머리글은 영상 구간 요청(Range) 하나뿐
    const range = typeof m.range === "string" && /^bytes=\d{0,15}-\d{0,15}$/.test(m.range) ? m.range : null;
    const { status, type, headers, data } = await this.link.call({ method, path: m.path, body: Buffer.concat(got.parts), range, deviceId: this.device.id, conn: this.conn });
    // 큰 응답은 32KB씩 나눠 보낸다. 영상 구간 응답이면 Content-Range 등도 함께
    for (let i = 0; i === 0 || i < data.length; i += MAX_BODY_CHUNK) {
      const chunk = data.subarray(i, i + MAX_BODY_CHUNK);
      this.json({ t: "res", id, status, type, ...(i === 0 && headers ? { headers } : {}), body: chunk.toString("base64"), more: i + MAX_BODY_CHUNK < data.length });
      if (this.state === "dead") return;
    }
  }

  onOpen(m) {
    if (!Number.isInteger(m.sid) || typeof m.session !== "string" || !/^pt-[A-Za-z0-9_-]{1,32}$/.test(m.session)) throw new Error("open");
    if (this.terms.size >= 16 || this.terms.has(m.sid)) throw new Error("open");
    const term = this.link.spawn(m.session, m.create === true);
    const t = { term, buf: [], timer: null };
    this.terms.set(m.sid, t);
    const head = Buffer.alloc(4); head.writeUInt32BE(m.sid);
    // 출력은 30ms씩 모아 보낸다 (메시지 수·요금·타이밍 노출 줄이기)
    term.onData((d) => {
      t.buf.push(Buffer.from(d, "utf8"));
      if (t.timer) return;
      // 짧은 출력(타이핑에 대한 답)은 10ms 안에, 긴 출력은 30ms씩 모아 보낸다
      t.timer = setTimeout(() => {
        t.timer = null;
        let all = Buffer.concat(t.buf); t.buf = [];
        while (all.length) { const part = all.subarray(0, 60_000); all = all.subarray(60_000); this.send(2, Buffer.concat([head, part])); }
      }, t.buf.reduce((n, b) => n + b.length, 0) < 512 ? 10 : 30);
    });
    term.onExit(() => { this.terms.delete(m.sid); this.json({ t: "closed", sid: m.sid }); });
  }

  onInput(body) {
    if (body.length < 4) throw new Error("input");
    const t = this.terms.get(body.readUInt32BE(0));
    if (t) t.term.write(body.subarray(4).toString("utf8"));
  }
}

// ── 중계와의 연결 (끊기면 점점 늘린 간격 + 흔들기로 다시 붙는다) ─────
class Link {
  constructor({ handle, spawn }) {
    this.k = keys(); this.handle = handle; this.spawn = spawn;
    this.peers = new Map(); this.retry = 0;
    devices.events.on("allowed", () => this.sendAllow());
  }

  start() {
    if (!RELAY.startsWith("https://") && !RELAY.startsWith("http://127.0.0.1")) return console.log("중계 주소(PT_RELAY)가 없어 중계를 쓰지 않습니다");
    this.connect();
  }

  connect() {
    const url = RELAY.replace(/^http/, "ws") + `/v1/room/${this.k.room}?role=mac`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let ping;
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        const u8 = Buffer.from(e.data);
        if (u8.length < 4) return;
        const p = this.peers.get(u8.readUInt32BE(0));
        if (p) p.onMessage(u8.subarray(4));
        return;
      }
      if (e.data === "pong") return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "challenge") {
        const sig = crypto.sign("sha256", Buffer.concat([te("pocket-relay/1 room-owner"), te(this.k.room), Buffer.from(m.c, "base64")]), this.k.roomKey);
        ws.send(JSON.stringify({ t: "auth", pub: this.k.roomPub.toString("base64"), sig: sig.toString("base64"), allow: devices.allowHashes() }));
      } else if (m.t === "ok") {
        this.retry = 0;
        console.log(new Date().toISOString(), "중계에 붙음", this.k.room.slice(0, 6));
        ping = setInterval(() => { try { ws.send("ping"); } catch {} }, 20_000);
      } else if (m.t === "join" && Number.isInteger(m.conn)) {
        this.peers.get(m.conn)?.close();
        this.peers.set(m.conn, new Peer(this, m.conn, !!m.pairing));
      } else if (m.t === "leave") {
        this.peers.get(m.conn)?.close(); this.peers.delete(m.conn);
      }
    };
    ws.onclose = (e) => {
      clearInterval(ping);
      for (const p of this.peers.values()) p.close();
      this.peers.clear();
      if (this.ws !== ws) return;
      const wait = Math.min(60_000, 1000 * 2 ** Math.min(this.retry++, 6)) * (0.5 + Math.random());
      console.log(new Date().toISOString(), "중계 연결 끊김", e.code, `${Math.round(wait / 1000)}초 뒤 다시`);
      setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => {};
  }

  toPhone(conn, ct) {
    if (this.ws?.readyState !== 1) return;
    const head = Buffer.alloc(4); head.writeUInt32BE(conn);
    this.ws.send(Buffer.concat([head, ct]));
  }
  kick(conn) { this.peers.delete(conn); try { this.ws.send(JSON.stringify({ t: "kick", conn })); } catch {} }
  promote(conn) { try { this.ws.send(JSON.stringify({ t: "promote", conn })); } catch {} }
  sendAllow() { try { this.ws?.send(JSON.stringify({ t: "allow", hashes: devices.allowHashes() })); } catch {} }

  // 서버의 요청 처리(handle)를 직접 부른다. 가짜 요청·응답 객체를 만들고 req.relay를 붙인다 (네트워크 요청은 이 표시를 가질 수 없다)
  call({ method, path: target, body, range, deviceId, conn }) {
    return new Promise((resolve) => {
      const req = new EventEmitter();
      Object.assign(req, {
        relay: true, method, url: target,
        headers: { "x-device-id": deviceId, "content-type": "application/json", "content-length": String(body.length), ...(range ? { range } : {}) },
        socket: { remoteAddress: `relay:${conn}`, localPort: -1 },
        destroy() { this.destroyed = true; },
      });
      const chunks = [];
      let size = 0;
      let status = 200, type = "application/octet-stream", finished = false;
      const keep = {}; // 폰에 돌려줄 머리글 (영상 구간·파일 이름만)
      const res = new Writable({
        // 응답이 20MB를 넘으면 끊는다 (큰 영상은 앱이 구간(Range)으로 받는다. 통째로 메모리에 모으지 않게)
        write(c, _e, cb) {
          size += c.length;
          if (size > 20_000_000) { status = 413; chunks.length = 0; finish(); return cb(new Error("too big")); }
          chunks.push(Buffer.from(c)); cb();
        },
        final(cb) { cb(); finish(); },
      });
      const finish = () => { if (finished) return; finished = true; resolve({ status, type, headers: Object.keys(keep).length ? keep : null, data: Buffer.concat(chunks) }); };
      const note = (k, v) => {
        const key = String(k).toLowerCase();
        if (key === "content-type") type = String(v);
        else if (["content-range", "accept-ranges", "x-file-name"].includes(key)) keep[key] = String(v);
      };
      res.headersSent = false;
      res.writeHead = (code, headers = {}) => {
        status = code; res.headersSent = true;
        for (const [k, v] of Object.entries(headers)) note(k, v);
        return res;
      };
      res.setHeader = (k, v) => note(k, v);
      res.on("close", finish);
      try { this.handle(req, res); } catch { status = 400; res.end(); }
      // 본문을 흘려 준다 (withBody·upload가 data/end를 기다린다)
      setImmediate(() => { if (body.length) req.emit("data", body); req.emit("end"); });
    });
  }
}

let link = null;
function start(opts) { link = new Link(opts); link.start(); return link; }

module.exports = { start, pairLink, keys, allowed, frame, unframe, pskOf, prologue, RELAY };
