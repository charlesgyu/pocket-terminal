// 바깥 길: Cloudflare 무료 터널(cloudflared)로 이 컴퓨터에 임시 https 주소를 만들고 주소록에 올린다.
// 주소는 cloudflared를 켤 때마다 바뀐다. 폰 앱은 주소록에서 최신 주소를 읽어 다시 붙는다.
// 화면·입력 내용은 터널로만 오가고, 주소록에는 주소만 적힌다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { HOME, TUNNEL_PORT, BOOK, topic, pair, readState, writeState } = require("./config");

function findCloudflared() {
  const list = [process.env.CLOUDFLARED, path.join(HOME, "bin", "cloudflared"),
                "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"];
  return list.find((p) => p && fs.existsSync(p));
}

function start() {
  const bin = findCloudflared();
  if (!bin) { console.log("cloudflared가 없어 바깥 주소 없이 켭니다 (이 컴퓨터 안·Tailscale에서만 연결)"); return; }
  const { id, key } = pair();
  let child = null;
  let url = null;
  let fails = 0;
  let retry = null;

  const publish = async () => {
    clearTimeout(retry);
    if (!url) return;
    // 폰 앱은 서명이 맞는 주소만 따른다 (게시판 이름이 새어도 가짜 주소는 무시됨)
    const at = Date.now();
    const sig = crypto.createHmac("sha256", key).update(`${url}\n${at}`).digest("hex");
    try {
      const r = await fetch(`${BOOK}/${topic(id)}`, {
        method: "POST", body: JSON.stringify({ url, at, sig }), signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error("응답 " + r.status);
      console.log("주소록에 올림", url);
    } catch (e) {
      console.log("주소록에 못 올림, 1분 뒤 다시:", e.message);
      retry = setTimeout(publish, 60_000);
    }
  };

  const run = () => {
    url = null;
    writeState({ ...readState(), url: null });
    child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${TUNNEL_PORT}`],
                  { stdio: ["ignore", "pipe", "pipe"] });
    const onData = (d) => {
      const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (!m || m[0] === url) return;
      url = m[0];
      writeState({ ...readState(), url, at: Date.now() });
      console.log("바깥 주소", url);
      publish();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      console.log("터널이 꺼짐(" + code + "), 10초 뒤 다시 켭니다");
      child = null;
      setTimeout(run, 10_000);
    });
  };

  // 5분마다 바깥 주소로 들어와 보고, 3번 연달아 안 되면 터널을 새로 켠다 (새 주소는 주소록에 다시 올라감)
  setInterval(async () => {
    if (!url || !child) return;
    try {
      const r = await fetch(url + "/health", { signal: AbortSignal.timeout(15_000) });
      if (r.ok) { fails = 0; return; }
    } catch {}
    if (++fails >= 3) { fails = 0; console.log("바깥 주소가 응답하지 않아 터널을 다시 켭니다"); child.kill(); }
  }, 5 * 60_000);
  // ntfy는 글을 12시간만 보관하므로 3시간마다 다시 올린다
  setInterval(publish, 3 * 3600_000);

  process.on("exit", () => child && child.kill());
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
  run();
}

module.exports = { start };
