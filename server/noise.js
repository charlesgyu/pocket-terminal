// Noise_NKpsk2_25519_ChaChaPoly_SHA256 (Noise 표준 34판 그대로. 직접 고안하지 않는다. docs/relay-design.md 5절)
//   <- s            폰(시작하는 쪽)은 Mac의 Noise 공개키를 QR로 미리 안다
//   ...
//   -> e, es        폰 → Mac
//   <- e, ee, psk   Mac → 폰 (psk = 접속 토큰, QR이 없으면 통과 못 함)
// 맞는지는 표준 시험값(cacophony)으로 확인한다: node server/noise.js <vectors.json>
// 같은 규칙을 아이폰(CryptoKit)·안드로이드(Tink)에도 똑같이 짜고 같은 시험값으로 맞춘다.
const crypto = require("crypto");

const NAME = "Noise_NKpsk2_25519_ChaChaPoly_SHA256";
const DHLEN = 32, HASHLEN = 32, TAG = 16;
const MAX_NONCE = 2n ** 64n - 2n; // 이 앞에서 끊는다 (2^64-1은 표준이 예약)

const X_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const X_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const pubKey = (raw) => crypto.createPublicKey({ key: Buffer.concat([X_SPKI, raw]), format: "der", type: "spki" });
const privKey = (raw) => crypto.createPrivateKey({ key: Buffer.concat([X_PKCS8, raw]), format: "der", type: "pkcs8" });
const rawPub = (k) => k.export({ type: "spki", format: "der" }).subarray(-32);
const rawPriv = (k) => k.export({ type: "pkcs8", format: "der" }).subarray(-32);

// 키 쌍: { priv, pub } 모두 32바이트 Buffer
function keyPair(privRaw) {
  const priv = privRaw ? privKey(privRaw) : crypto.generateKeyPairSync("x25519").privateKey;
  return { priv: rawPriv(priv), pub: rawPub(crypto.createPublicKey(priv)) };
}
const dh = (kp, pub) => {
  const out = crypto.diffieHellman({ privateKey: privKey(kp.priv), publicKey: pubKey(pub) });
  // 상대가 작은 차수 점을 보내 공유값이 0이 되면 끊는다
  if (out.every((b) => b === 0)) throw new Error("bad dh");
  return out;
};

const sha256 = (...p) => crypto.createHash("sha256").update(Buffer.concat(p)).digest();
const hmac = (k, ...p) => crypto.createHmac("sha256", k).update(Buffer.concat(p)).digest();
function hkdf(ck, ikm, n) {
  const t = hmac(ck, ikm);
  const o1 = hmac(t, Buffer.from([1]));
  const o2 = hmac(t, o1, Buffer.from([2]));
  if (n === 2) return [o1, o2];
  return [o1, o2, hmac(t, o2, Buffer.from([3]))];
}

// ChaChaPoly 넌스: 앞 4바이트 0 + 64비트 리틀엔디언 카운터
function nonce(n) {
  const b = Buffer.alloc(12);
  b.writeBigUInt64LE(n, 4);
  return b;
}
function seal(k, n, ad, pt) {
  const c = crypto.createCipheriv("chacha20-poly1305", k, nonce(n), { authTagLength: TAG });
  c.setAAD(ad, { plaintextLength: pt.length });
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}
function open(k, n, ad, ct) {
  if (ct.length < TAG) throw new Error("short");
  const d = crypto.createDecipheriv("chacha20-poly1305", k, nonce(n), { authTagLength: TAG });
  d.setAAD(ad, { plaintextLength: ct.length - TAG });
  d.setAuthTag(ct.subarray(ct.length - TAG));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - TAG)), d.final()]);
}

class CipherState {
  constructor(k) { this.k = k || null; this.n = 0n; }
  encrypt(ad, pt) {
    if (!this.k) return Buffer.from(pt);
    if (this.n > MAX_NONCE) throw new Error("nonce exhausted");
    return seal(this.k, this.n++, ad, pt);
  }
  // 실패하면 카운터를 올리지 않고 던진다 (부르는 쪽은 연결을 끊는다)
  decrypt(ad, ct) {
    if (!this.k) return Buffer.from(ct);
    if (this.n > MAX_NONCE) throw new Error("nonce exhausted");
    const pt = open(this.k, this.n, ad, ct);
    this.n++;
    return pt;
  }
}

class Handshake {
  // initiator: 폰(true) / Mac(false). s: Mac의 정적 키 쌍(Mac만). rs: Mac Noise 공개키(폰만). psk: 32바이트
  // e: 시험할 때만 고정 임시 키 (실제로는 매번 새로 만든다)
  constructor({ initiator, prologue = Buffer.alloc(0), s, rs, psk, e }) {
    if (!psk || psk.length !== 32) throw new Error("psk must be 32 bytes");
    this.initiator = initiator;
    this.s = s; this.rs = rs; this.psk = psk; this.fixedE = e;
    const name = Buffer.from(NAME);
    this.h = name.length <= HASHLEN ? Buffer.concat([name, Buffer.alloc(HASHLEN - name.length)]) : sha256(name);
    this.ck = Buffer.from(this.h);
    this.cs = new CipherState();
    this.mixHash(prologue);
    this.mixHash(initiator ? rs : s.pub); // <- s (미리 아는 Mac 공개키)
    this.step = 0;
  }
  mixHash(d) { this.h = sha256(this.h, d); }
  mixKey(ikm) { const [ck, k] = hkdf(this.ck, ikm, 2); this.ck = ck; this.cs = new CipherState(k); }
  mixKeyAndHash(ikm) { const [ck, th, k] = hkdf(this.ck, ikm, 3); this.ck = ck; this.mixHash(th); this.cs = new CipherState(k); }
  encryptAndHash(p) { const c = this.cs.encrypt(this.h, p); this.mixHash(c); return c; }
  decryptAndHash(c) { const p = this.cs.decrypt(this.h, c); this.mixHash(c); return p; }

  // 내 차례 메시지를 만든다
  write(payload = Buffer.alloc(0)) {
    if (this.initiator && this.step === 0) {            // -> e, es
      this.e = keyPair(this.fixedE);
      this.mixHash(this.e.pub); this.mixKey(this.e.pub); // psk 모드에서는 e도 mixKey
      this.mixKey(dh(this.e, this.rs));
      const out = Buffer.concat([this.e.pub, this.encryptAndHash(payload)]);
      this.step = 1;
      return out;
    }
    if (!this.initiator && this.step === 1) {           // <- e, ee, psk
      this.e = keyPair(this.fixedE);
      this.mixHash(this.e.pub); this.mixKey(this.e.pub);
      this.mixKey(dh(this.e, this.re));
      this.mixKeyAndHash(this.psk);
      const out = Buffer.concat([this.e.pub, this.encryptAndHash(payload)]);
      this.step = 2;
      return out;
    }
    throw new Error("not my turn");
  }

  // 상대 메시지를 읽는다. 틀리면 던진다
  read(msg) {
    if (!this.initiator && this.step === 0) {            // -> e, es
      if (msg.length < DHLEN + TAG) throw new Error("short");
      this.re = msg.subarray(0, DHLEN);
      this.mixHash(this.re); this.mixKey(this.re);
      this.mixKey(dh(this.s, this.re));
      const p = this.decryptAndHash(msg.subarray(DHLEN));
      this.step = 1;
      return p;
    }
    if (this.initiator && this.step === 1) {             // <- e, ee, psk
      if (msg.length < DHLEN + TAG) throw new Error("short");
      this.re = msg.subarray(0, DHLEN);
      this.mixHash(this.re); this.mixKey(this.re);
      this.mixKey(dh(this.e, this.re));
      this.mixKeyAndHash(this.psk);
      const p = this.decryptAndHash(msg.subarray(DHLEN));
      this.step = 2;
      return p;
    }
    throw new Error("unexpected message");
  }

  get done() { return this.step === 2; }

  // 끝나면 방향별 전송 열쇠와 핸드셰이크 해시(폰 보안 칩 서명이 이것에 묶인다)
  split() {
    if (!this.done) throw new Error("handshake not done");
    const [k1, k2] = hkdf(this.ck, Buffer.alloc(0), 2);
    const i2r = new CipherState(k1), r2i = new CipherState(k2);
    const out = { hash: Buffer.from(this.h), send: this.initiator ? i2r : r2i, recv: this.initiator ? r2i : i2r };
    // 핸드셰이크 상태의 비밀값은 버린다
    this.e = this.s = this.psk = this.ck = this.cs = null;
    return out;
  }
}

module.exports = { Handshake, keyPair, NAME };

// 표준 시험값으로 확인: node server/noise.js cacophony.json
if (require.main === module) {
  const all = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
  const list = (all.vectors || all).filter((v) => v.protocol_name === NAME);
  const hx = (s) => Buffer.from(s, "hex");
  let bad = 0;
  for (const v of list) {
    const i = new Handshake({ initiator: true, prologue: hx(v.init_prologue), rs: hx(v.init_remote_static), psk: hx(v.init_psks[0]), e: hx(v.init_ephemeral) });
    const r = new Handshake({ initiator: false, prologue: hx(v.resp_prologue), s: keyPair(hx(v.resp_static)), psk: hx(v.resp_psks[0]), e: hx(v.resp_ephemeral) });
    let iT, rT;
    v.messages.forEach((m, n) => {
      const fromInit = n % 2 === 0;
      let ct, pt;
      if (n < 2) {
        ct = fromInit ? i.write(hx(m.payload)) : r.write(hx(m.payload));
        pt = fromInit ? r.read(ct) : i.read(ct);
        if (n === 1) { iT = i.split(); rT = r.split(); }
      } else {
        ct = (fromInit ? iT.send : rT.send).encrypt(Buffer.alloc(0), hx(m.payload));
        pt = (fromInit ? rT.recv : iT.recv).decrypt(Buffer.alloc(0), ct);
      }
      if (ct.toString("hex") !== m.ciphertext || pt.toString("hex") !== m.payload) { bad++; console.log("다름: 메시지", n); }
    });
    if (v.handshake_hash && iT.hash.toString("hex") !== v.handshake_hash) { bad++; console.log("다름: 핸드셰이크 해시"); }
  }
  console.log(`${NAME}: 시험값 ${list.length}개, ${bad ? "틀림 " + bad : "모두 같음"}`);
  process.exit(bad ? 1 : 0);
}
