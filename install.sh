#!/bin/bash
# 포켓 터미널 한 줄 설치 (Mac): curl -fsSL https://charlesgyu.github.io/pocket-terminal/install.sh | bash
# 하는 일: 정해진 판(bd52fd2)의 묶음을 받아 지문(SHA256)이 맞을 때만 ~/.pocket-terminal/src 에 풀고,
# pocket-terminal 명령을 ~/.local/bin 에 둔 뒤 설치를 이어 간다(tmux 설치, 서버 등록, 연결 QR).
# 함수로 감싸 끝까지 받은 뒤에만 실행된다 (받다가 끊겨 반쪽만 실행되는 일이 없게)
main() {
  set -euo pipefail
  local VER="bd52fd2" SHA="435e8f77ae517953882265817a1c6545dcedd566d1de9c809a34c330e16a73bc" URL="https://charlesgyu.github.io/pocket-terminal/dist/pocket-terminal-bd52fd2.tar.gz"
  local PT="$HOME/.pocket-terminal" say
  say() { echo "[포켓 터미널] $*"; }
  [ "$(uname)" = Darwin ] || { say "지금은 Mac만 지원합니다."; exit 1; }
  umask 077

  # node 22 이상이 필요하다 (서버). 없으면 Homebrew로 설치한다
  local node; node="$(command -v node || true)"
  if [ -z "$node" ] || [ "$("$node" -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
    if command -v brew >/dev/null 2>&1; then say "node 설치 중 (Homebrew)"; brew install node >/dev/null
    else say "node 22 이상이 필요합니다. https://nodejs.org 에서 설치하거나 Homebrew(https://brew.sh)를 설치한 뒤 다시 실행해 주세요."; exit 1; fi
  fi

  # 임시 폴더는 끝날 때 지운다 (함수 밖에서도 보이게 전역 변수, 비어 있으면 지우지 않는다)
  PT_TMP="$(mktemp -d)"
  trap 'rm -rf -- "${PT_TMP:?}"' EXIT
  local tmp="$PT_TMP"
  say "내려받는 중 ($VER)"
  curl -fsSL "$URL" -o "$tmp/pt.tgz"
  [ "$(shasum -a 256 "$tmp/pt.tgz" | cut -d' ' -f1)" = "$SHA" ] || { say "받은 파일의 지문(SHA256)이 맞지 않아 설치하지 않았습니다."; exit 1; }
  mkdir -p "$tmp/src" "$PT" && chmod 700 "$PT"
  tar -xzf "$tmp/pt.tgz" -C "$tmp/src"
  # 새 판으로 바꿔 끼운다 (예전 판은 다 옮긴 뒤 지운다)
  rm -rf -- "${PT:?}/src.old"
  if [ -d "$PT/src" ]; then mv "$PT/src" "$PT/src.old"; fi
  mv "$tmp/src" "$PT/src" && rm -rf -- "${PT:?}/src.old"

  mkdir -p "$HOME/.local/bin"
  ln -sf "$PT/src/scripts/pocket-terminal" "$HOME/.local/bin/pocket-terminal"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *)
    say "pocket-terminal 명령을 쓰려면 ~/.local/bin 이 PATH에 있어야 합니다. 다음 줄을 ~/.zshrc 에 넣어 주세요:"
    echo '    export PATH="$HOME/.local/bin:$PATH"' ;;
  esac
  # 이어서 설치하고 고르게 한다 (curl | bash 로 실행돼도 키보드 입력은 터미널에서 받는다)
  if { : </dev/tty; } 2>/dev/null; then bash "$PT/src/scripts/pt.sh" install </dev/tty; else bash "$PT/src/scripts/pt.sh" install; fi
}
main "$@"
