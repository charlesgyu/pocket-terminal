// 폰 연결용 QR을 터미널 안에 그린다. 주소록 위치, 이 컴퓨터 번호·이름, 서명 열쇠, 토큰을 담는다.
// 바깥 주소는 넣지 않는다 (앱이 주소록에서 읽는다). 그만큼 QR이 작아져 터미널에서도 잘 찍힌다.
// 폰 기본 카메라로 찍으면 앱이 열리면서 바로 연결된다. 한 번 연결하면 다시 찍을 필요가 없다.
//   node pair.js           → 어두운 터미널 기준으로 그림 (밝은 칸을 글자 블록으로 칠한다)
//   node pair.js --light   → 밝은 배경 터미널용
//   node pair.js --image   → 터미널 대신 ~/.pocket-terminal/pair-<무작위>.png 그림으로 저장해 연다
//   node pair.js --window  → 새 터미널 창을 열어 거기에 그린다 (Claude가 부를 때. QR이 대화 기록에 남지 않게)
//                            창 파일에는 비밀값을 적지 않는다. 창이 이 스크립트를 다시 실행해 그린다. Enter를 누르면 지우고 닫힌다
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, execFileSync } = require("child_process");
const QRCode = require("qrcode");
const { HOME, BOOK, token, pair } = require("./config");

// 위아래 두 칸을 글자 하나(▀ ▄ █ 공백)로 그린다. light=true면 밝은 칸을 칠한다(어두운 터미널).
function draw(link, paintLight) {
  const qr = QRCode.create(link, { errorCorrectionLevel: "L" });
  const n = qr.modules.size;
  const M = 2; // 둘레 여백 칸
  const dark = (x, y) => x >= 0 && y >= 0 && x < n && y < n && qr.modules.get(y, x) === 1;
  const on = (x, y) => (paintLight ? !dark(x, y) : dark(x, y));
  const lines = [];
  for (let y = -M; y < n + M; y += 2) {
    let line = "";
    for (let x = -M; x < n + M; x++) {
      const top = on(x, y), bottom = y + 1 < n + M && on(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// 앱의 컴퓨터 목록에 보일 이름 (시스템 설정의 컴퓨터 이름, 없으면 호스트 이름)
function computerName() {
  try { return execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim().slice(0, 40); } catch {}
  return os.hostname().replace(/\.local$/, "").slice(0, 40);
}

async function main() {
  if (process.argv.includes("--window")) {
    const dir = path.join(HOME, "ask");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(dir)) if (/^qr-[0-9a-f]+\.command$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
    const file = path.join(dir, `qr-${require("crypto").randomBytes(4).toString("hex")}.command`);
    const sq = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";
    const light = process.argv.includes("--light") ? " --light" : "";
    fs.writeFileSync(file, [
      "#!/bin/bash",
      "clear",
      `${sq(process.execPath)} ${sq(__filename)}${light}`,
      `echo; echo "  포켓 터미널 앱으로 위 QR을 찍으세요. 찍은 뒤 승인 창이 뜨면 폰의 확인 번호와 같은지 보고 y."`,
      `echo "  QR이 안 찍히면 창을 크게 하거나 글자를 작게(Cmd -) 하세요."`,
      `echo "  승인 창이 뜨면 이 창은 저절로 닫힙니다. (Enter를 누르거나 5분이 지나도 닫힙니다)"`,
      // 승인 요청(ask/<번호>.json)이 생기면(= 폰이 QR을 찍었으면) 닫는다
      `for i in $(seq 1 300); do read -t 1 -r _ && break; ls ${sq(dir)}/*.json >/dev/null 2>&1 && break; done`,
      "clear; printf '\\e[3J'",
      `rm -f -- "$0"`,
      ...require("./config").closeWindowLines(),
    ].join("\n") + "\n", { mode: 0o700 });
    execFile("/usr/bin/open", [file]);
    console.log("새 터미널 창에 연결 QR을 띄웠습니다.");
    return;
  }
  const { id, key } = pair();
  // QR 2판: 포켓 터미널 중계 서버로 끝에서 끝 암호 연결 (docs/relay-design.md 10.6). PT_QR=1 이면 예전 1판(터널+주소록)
  const link = process.env.PT_QR === "1"
    ? "pocketterminal://pair?" + new URLSearchParams({ book: BOOK, id, key, token: token(), name: computerName() })
    : require("./relay").pairLink(computerName());
  if (process.argv.includes("--image")) {
    // 매번 새 이름으로 만든다 (같은 이름이면 미리보기가 예전 창을 그대로 보여 줄 수 있다). 예전 그림은 지운다
    for (const f of fs.readdirSync(HOME)) if (/^pair(-[0-9a-f]+)?\.png$/.test(f)) fs.rmSync(path.join(HOME, f), { force: true });
    const png = path.join(HOME, `pair-${require("crypto").randomBytes(4).toString("hex")}.png`);
    await QRCode.toFile(png, link, { width: 520, margin: 2 });
    fs.chmodSync(png, 0o600); // 토큰·열쇠가 들어 있으니 나만 읽게
    // 미리보기로 열고 맨 앞으로 가져온다 (다른 창 뒤에 숨지 않게)
    execFile("/usr/bin/open", ["-a", "Preview", png], () =>
      execFile("/usr/bin/osascript", ["-e", 'tell application "Preview" to activate'], () => {}));
    console.log("QR 그림을 열었습니다:", png);
    return;
  }
  console.log(draw(link, !process.argv.includes("--light")));
}

// relay·devices가 파일 감시를 켜 두므로 다 그리면 바로 끝낸다
main().then(() => process.exit(0), () => process.exit(1));
