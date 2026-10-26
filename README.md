# Pocket Terminal · 포켓 터미널 (computer-side plugin)

The Claude Code plugin that connects the **Pocket Terminal** iPhone app to Claude Code on your own computer.
아이폰 앱 **포켓 터미널**을 내 컴퓨터의 Claude Code에 연결하는 Claude Code 플러그인입니다.

## Install · 설치

Paste this into Claude Code on your computer. 컴퓨터의 Claude Code에 붙여 넣으세요.

```
Install Pocket Terminal. Run claude plugin marketplace add charlesgyu/pocket-terminal and claude plugin install pocket-terminal@pocket-terminal, then follow the pocket-terminal skill (SKILL.md) in ~/.claude/plugins/cache/pocket-terminal to finish the setup.
```

## What it does on your computer · 컴퓨터에서 하는 일

- Installs `tmux` and `cloudflared` (Homebrew) if missing. 없으면 tmux, cloudflared 설치
- Copies the server to `~/.pocket-terminal/app` and installs its locked npm dependencies (`npm ci`). 서버를 복사하고 잠금 파일대로 의존성 설치
- Registers a login item (launchd `com.pocketterminal.server`). 로그인할 때 자동 시작 등록
- Adds a Claude Code `PermissionRequest` hook so permission prompts can be answered from the phone. 권한 질문을 폰에서 답하는 훅 등록
- Opens a Cloudflare quick tunnel and posts its signed address to an ntfy.sh board. 터널 주소를 서명해 ntfy.sh에 올림

Turn everything off: `bash scripts/pt.sh off`. 모두 끄기: `bash scripts/pt.sh off`

## Security · 보안

The server listens only on 127.0.0.1 (and on your Tailscale address, if you use Tailscale). Every request needs the access token and a signature from the phone's Secure Enclave key, bound to the address it is sent to, and a new device must be approved on the computer after comparing a 6-digit code. Cloudflare relays the tunnel and can technically see its traffic.
See [SECURITY.md](SECURITY.md). Privacy policy: https://charlesgyu.github.io/pocket-terminal-legal/privacy-en.html

서버는 127.0.0.1(Tailscale을 쓰면 그 주소도)에서만 받습니다. 모든 요청에 토큰과, 받는 주소까지 묶은 폰 보안 칩 열쇠의 서명이 필요합니다. 새 기기는 6자리 확인 번호를 대조한 뒤 컴퓨터에서 승인해야 합니다. 터널을 중계하는 Cloudflare는 기술적으로 내용을 볼 수 있습니다.

Copyright (c) 2026 contentsB. All rights reserved. See [LICENSE](LICENSE).
