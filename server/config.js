// 서버·QR 스크립트가 함께 쓰는 설정과 비밀값. 모두 ~/.pocket-terminal 아래에 둔다.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const HOME = process.env.PT_HOME || path.join(os.homedir(), ".pocket-terminal");
// 이 Mac의 다른 사용자가 읽지 못하게 폴더째 나만 읽게 한다 (게시판·로그·터널 주소가 들어 있다)
fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
try { fs.chmodSync(HOME, 0o700); } catch {}

const PORT = Number(process.env.PORT || 8790);
// cloudflared가 붙는 터널 전용 포트 (이 포트로 온 요청만 Cloudflare의 접속 위치 머리글을 믿는다)
const TUNNEL_PORT = Number(process.env.TUNNEL_PORT || PORT + 1);

// 주소록: 컴퓨터를 켤 때마다 바뀌는 터널 주소를 적어 두는 곳. 가입 없이 쓰는 ntfy.sh 게시판을 쓴다.
// 게시판 이름은 이 컴퓨터 번호로 정하고, 올리는 주소에는 비밀 열쇠로 서명해서 가짜 주소를 막는다.
const BOOK = (process.env.PT_BOOK || "https://ntfy.sh").replace(/\/$/, "");
const topic = (id) => "pt-" + id;

// 작업 폴더: 창을 처음 여는 곳이자, 팀이 일하고 앱이 결과물을 열어 볼 수 있는 유일한 곳.
// 베이스캠프 폴더가 있으면 거기, 없으면 ~/PocketTerminal 을 만든다. 홈 전체(~/Library 등)를 열어 두지 않는다.
const BASECAMP = path.join(os.homedir(), "클로드 전용 폴더");
const WORKDIR = process.env.WORKDIR || (fs.existsSync(BASECAMP) ? BASECAMP : path.join(os.homedir(), "PocketTerminal"));
fs.mkdirSync(WORKDIR, { recursive: true });

// 파일이 없으면 만들어 두고 읽는다 (처음 한 번만 만들어지는 비밀값)
function secretFile(name, make) {
  const file = path.join(HOME, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, make(), { mode: 0o600 });
  return fs.readFileSync(file, "utf8").trim();
}

// 터미널 창(.command)이 끝난 뒤 그 창을 닫는 줄. 스크립트가 끝난 뒤에 닫아야 "실행 중인 프로세스를 끝낼까요?"를 묻지 않으므로,
// 탭과 떨어진 프로세스(setsid)가 창 이름(=.command 파일 이름)으로 찾아, 창이 한가해질 때까지 몇 번 닫아 본다 (close-window.applescript)
const closeWindowLines = () => [
  `me="$(basename "$0")"`,
  `perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' /bin/sh -c 'for i in 1 2 3 4 5 6 7 8 9 10; do sleep 0.6; osascript "$2" "$1" 2>/dev/null | grep -q gone && break; done' sh "$me" ${JSON.stringify(require("path").join(__dirname, "close-window.applescript"))} </dev/null >/dev/null 2>&1 &`,
  `exit 0`,
];

const random = (n) => crypto.randomBytes(n).toString("base64url");

// 앱이 모든 요청에 붙이는 비밀값
const token = () => secretFile("token", () => random(24) + "\n");

// 주소록에서 이 컴퓨터를 찾는 번호(id)와, 올리는 주소에 서명하는 열쇠(key). 둘 다 QR로 폰에 넘어간다.
const pair = () => JSON.parse(secretFile("pair.json", () => JSON.stringify({ id: random(16), key: random(24) })));

const STATE = path.join(HOME, "state.json");
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } };
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s));

module.exports = { closeWindowLines, HOME, PORT, TUNNEL_PORT, BOOK, topic, WORKDIR, token, pair, readState, writeState };
