#!/bin/bash
# 포켓 터미널 컴퓨터 쪽 관리. 터미널 명령 pocket-terminal(한 줄 설치가 둔다)과 Claude 스킬(/pocket-terminal)이 부른다.
#   pt.sh            설치(또는 갱신)하고 켠 뒤 고르게 한다: 1. 스마트폰과 연결하기(QR) 2. 나중에 하기
#   pt.sh setup      설치(또는 갱신)하고 켜기만 한다. 스킬은 이것을 부른 뒤 Claude 선택창으로 1/2를 묻는다
#   pt.sh later      나중에 연결하는 방법 안내
#   pt.sh push <AuthKey_XXXX.p8> <키 ID> <팀 ID>   앱을 닫아도 오는 알림(Apple 푸시) 열쇠 등록
#   pt.sh qr         연결 QR만 다시 띄운다 (--light: 밝은 배경 터미널용, --image: 그림 파일로 열기)
#   pt.sh status     켜져 있는지, 바깥 주소가 있는지
#   pt.sh off        끄고 자동 시작도 없앤다 (설치한 파일과 연결 정보는 남긴다)
#   pt.sh devices    허용한 기기 목록
#   pt.sh remove <번호>  기기 하나 빼기 (그 폰만 끊김, 폰을 잃어버렸을 때)
#   pt.sh reset      토큰·컴퓨터 번호·열쇠를 새로 만들고 허용한 기기도 모두 지운다. 모든 폰이 끊기고 새 QR로 다시 연결해야 한다
#                    (QR이 새었을 때)
# 새 기기가 처음 연결하려 하면 이 컴퓨터에 터미널 창이 떠서 y/n을 묻는다(1분 지나면 자동 거절). 허용한 기기만 들어온다.
# 서버는 ~/.pocket-terminal/app 에 두고, 컴퓨터를 켜면 launchd가 저절로 켠다.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
PT="$HOME/.pocket-terminal"
APP="$PT/app"
LABEL="com.pocketterminal.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

say() { echo "[포켓 터미널] $*"; }

# 이 Mac의 다른 사용자가 읽지 못하게 (게시판·로그·터널 주소·비밀값이 들어 있다)
umask 077
mkdir -p "$PT" && chmod 700 "$PT"

need_mac() {
  [ "$(uname)" = Darwin ] || { say "지금은 Mac만 지원합니다."; exit 1; }
}

has() { command -v "$1" >/dev/null 2>&1 || [ -x "/opt/homebrew/bin/$1" ] || [ -x "/usr/local/bin/$1" ]; }

install_deps() {
  NODE="$(command -v node || true)"
  [ -n "$NODE" ] || { say "node가 없습니다. https://nodejs.org 에서 설치한 뒤 다시 실행해 주세요."; exit 1; }
  if ! has tmux; then
    has brew || { say "tmux가 필요합니다. Homebrew(https://brew.sh)를 먼저 설치한 뒤 다시 실행해 주세요."; exit 1; }
    say "tmux 설치 중"
    brew install tmux >/dev/null
  fi
  # 바깥 연결은 포켓 터미널 중계 서버(끝에서 끝 암호)로 한다. 예전 임시 터널(cloudflared)은 설치하지 않는다
}

install_app() {
  say "서버 설치 중"
  mkdir -p "$APP"
  rsync -a --delete --exclude node_modules --exclude .token "$SRC/server/" "$APP/"
  # 잠금 파일(package-lock.json)에 적힌 버전 그대로만 설치한다 (npm ci는 다른 버전을 받지 않는다)
  (cd "$APP" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
}

# 컴퓨터를 켜면(로그인하면) 저절로 켜지고, 꺼지면 다시 켜지게 등록
install_launchd() {
  mkdir -p "$HOME/Library/LaunchAgents"
  # plist 안에 넣는 값은 XML 특수문자를 바꿔 넣는다
  x() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
  local xNODE xAPP xPATH xPT
  xNODE="$(x "$NODE")"; xAPP="$(x "$APP")"; xPATH="$(x "$PATH")"; xPT="$(x "$PT")"
  (umask 022; cat > "$PLIST") <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$xNODE</string><string>$xAPP/server.js</string></array>
  <key>WorkingDirectory</key><string>$xAPP</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$xPATH</string>
    <key>LANG</key><string>ko_KR.UTF-8</string>
    <key>TUNNEL</key><string>0</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$xPT/server.log</string>
  <key>StandardErrorPath</key><string>$xPT/server.log</string>
</dict>
</plist>
EOF
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  # 끄기는 바로 끝나지 않는다. 옛 것이 다 내려간 뒤 등록해야 "Input/output error"가 안 난다
  for _ in $(seq 1 20); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
  for i in 1 2 3; do
    launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && return
    sleep 1
  done
  launchctl bootstrap "$DOMAIN" "$PLIST"
}

# Claude Code 권한 요청을 폰으로도 보내는 훅을 ~/.claude/settings.json 에 넣거나(on) 뺀다(off).
# 다른 설정은 건드리지 않고 이 훅 한 줄만 다룬다. 컴퓨터의 질문 창은 그대로 뜨고, 폰과 먼저 답한 쪽이 이긴다.
hook() {
  # Claude Code를 쓰는 컴퓨터에만 넣는다 (Codex 등만 쓰는 컴퓨터는 건너뛴다). 뺄 때는 늘 확인한다
  if [ "$1" = on ] && [ ! -d "$HOME/.claude" ] && ! has claude; then return 0; fi
  NODE="${NODE:-$(command -v node)}"
  "$NODE" - "$1" "$NODE" "$APP/permission-hook.js" <<'JS'
const fs = require("fs"), path = require("path"), os = require("os");
const [mode, node, script] = process.argv.slice(2);
const file = path.join(os.homedir(), ".claude", "settings.json");
let s = {};
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (fs.existsSync(file)) { console.log("[포켓 터미널] settings.json을 읽지 못해 권한 훅은 건너뜁니다."); process.exit(0); } }
const mine = (h) => String(h.command || "").includes("permission-hook.js") && String(h.command).includes(".pocket-terminal");
const groups = ((s.hooks || {}).PermissionRequest || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !mine(h)) })).filter((g) => g.hooks.length);
const sq = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'"; // 셸 작은따옴표 감싸기 ($, ` 가 펼쳐지지 않게)
if (mode === "on") groups.push({ hooks: [{ type: "command", command: `${sq(node)} ${sq(script)}`, timeout: 900 }] });
s.hooks = s.hooks || {};
if (groups.length) s.hooks.PermissionRequest = groups; else delete s.hooks.PermissionRequest;
if (!Object.keys(s.hooks).length) delete s.hooks;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
JS
}

# QR에는 접속 비밀값이 들어 있다. 사람이 터미널에서 직접 실행했을 때만 글자로 그리고,
# Claude 같은 프로그램이 실행하면(출력이 터미널이 아니면) 글자로 내보내지 않고 이 컴퓨터 화면에 그림 창으로만 연다.
# 그래야 QR이 Claude 대화 기록이나 로그에 남지 않는다. 그림 파일은 10분 뒤 지운다.
show_qr() {
  NODE="${NODE:-$(command -v node)}"
  if [ -t 1 ] && [[ " $* " != *" --image "* ]]; then
    echo
    "$NODE" "$APP/pair.js" "$@"
    echo
    say "휴대폰 카메라나 포켓 터미널 앱으로 위 QR을 찍으면 연결됩니다. 한 번만 찍으면 됩니다."
    say "QR이 안 찍히면: pt.sh qr --light (밝은 배경 터미널) 또는 pt.sh qr --image (그림으로 열기)"
  else
    if [[ " $* " == *" --image "* ]]; then
      "$NODE" "$APP/pair.js" --image >/dev/null
      nohup sh -c 'sleep 600; rm -f "$1"/pair*.png' sh "$PT" >/dev/null 2>&1 &
      say "이 컴퓨터 화면에 연결 QR 그림 창을 열었습니다. (그림은 10분 뒤 지워집니다)"
    else
      "$NODE" "$APP/pair.js" --window "$@" >/dev/null
      say "이 컴퓨터에 새 터미널 창을 열어 연결 QR을 띄웠습니다. 휴대폰의 포켓 터미널 앱으로 찍으세요."
    fi
  fi
  say "찍은 뒤 이 컴퓨터에 승인 창이 뜨면, 폰에 보이는 확인 번호와 같은지 보고 1분 안에 y를 눌러 허용하세요."
}

later() {
  say "나중에 연결하려면 터미널에서 pocket-terminal qr 을 입력하세요. 연결 QR이 나옵니다."
  say "(Claude Code를 쓴다면 \"포켓터미널 연결해줘\"라고 말해도 됩니다)"
  say "서버는 이미 켜져 있고, 컴퓨터를 다시 켜도 저절로 켜집니다."
}

# 사람이 터미널에서 직접 실행했을 때만 묻는다 (Claude가 부르면 입력이 없으므로 묻지 않음)
choose() {
  echo
  say "설치가 끝났습니다. 무엇을 할까요?"
  echo "  1. 스마트폰과 연결하기"
  echo "  2. 나중에 하기"
  while true; do
    read -r -p "  번호를 누르고 Enter: " a </dev/tty
    case "$a" in
      1) show_qr; return ;;
      2) echo; later; return ;;
    esac
  done
}

# Apple 개발자 사이트에서 받은 푸시 열쇠(.p8)를 ~/.pocket-terminal/apns/ 에 두고 apns.json을 만든다
push_key() {
  local key="$1" kid="$2" team="$3"
  [ -f "$key" ] && [ -n "$kid" ] && [ -n "$team" ] || { echo "사용: pt.sh push <AuthKey_XXXX.p8> <키 ID> <팀 ID>"; exit 1; }
  mkdir -p "$PT/apns" && chmod 700 "$PT/apns"
  cp "$key" "$PT/apns/AuthKey_$kid.p8" && chmod 600 "$PT/apns/AuthKey_$kid.p8"
  printf '{"keyId":"%s","teamId":"%s","keyFile":"%s"}\n' "$kid" "$team" "$PT/apns/AuthKey_$kid.p8" > "$PT/apns.json"
  chmod 600 "$PT/apns.json"
  launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true
  say "푸시 열쇠를 등록했습니다. 이제 앱을 닫아도 알림이 옵니다."
}

status() {
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then say "켜져 있음"; else say "꺼져 있음"; fi
  # 중계 서버에 붙어 있는지 (서버 기록의 마지막 줄들로 본다)
  if tail -n 200 "$PT/server.log" 2>/dev/null | grep -q "중계에 붙음"; then say "중계 서버에 연결됨"; else say "중계 서버에 아직 연결되지 않음 (인터넷 연결 확인)"; fi
}

reset() {
  rm -f "$PT/token" "$PT/pair.json" "$PT/pair.png" "$PT/state.json" "$PT/devices.json" "$PT/push.json"
  # 새 비밀값을 먼저 만들어 둔다 (서버와 QR 스크립트가 동시에 만들다 엇갈리지 않게)
  NODE="${NODE:-$(command -v node)}"
  [ -f "$APP/config.js" ] && "$NODE" -e 'const c = require(process.argv[1]); c.token(); c.pair();' "$APP/config.js"
  # 서버가 새 토큰을 읽고 새 번호로 주소를 올리도록 다시 켠다
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "$DOMAIN/$LABEL"
    say "토큰과 열쇠를 새로 만들었습니다. 예전에 연결한 폰은 더 이상 들어올 수 없습니다."
    show_qr
  else
    say "토큰과 열쇠를 지웠습니다. 다음에 켤 때 새로 만들어집니다."
  fi
}

case "${1:-install}" in
  install) need_mac; install_deps; install_app; install_launchd; hook on
           # 사람이 터미널에서 실행했으면(한 줄 설치 포함) 바로 고르게 한다
           if [ -t 1 ] && { : </dev/tty; } 2>/dev/null; then choose; else say "설치가 끝났습니다."; later; fi ;;
  setup)   need_mac; install_deps; install_app; install_launchd; hook on; say "설치가 끝났습니다. 서버가 켜져 있습니다." ;;
  later)   later ;;
  push)    push_key "${2:-}" "${3:-}" "${4:-}" ;;
  qr)      shift; show_qr "$@" ;;
  status)  status ;;
  reset)   reset ;;
  devices) "$(command -v node)" "$APP/devices.js" list ;;
  remove)  "$(command -v node)" "$APP/devices.js" remove "${2:-}" ;;
  off)     launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; hook off; say "껐습니다. 자동 시작과 권한 알림 훅도 없앴습니다." ;;
  *)       echo "사용: pt.sh [install|setup|qr|later|push|status|off|devices|remove <번호>|reset]"; exit 1 ;;
esac
