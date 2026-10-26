// 이 Mac에 깔린 AI 터미널 도구 (사용자 결정 2026-10-27: Claude 전용이 아니라 어떤 AI든 돌리는 터미널 리모컨).
// 앱은 이 목록으로 새 창 기본 명령·팀원 도구 선택지를 보여 준다. 실제 실행은 로그인 셸(zsh -l)의 PATH로 찾는다.
const { execFile } = require("child_process");

// Claude만 팀 도구 허락 목록·대화방 자동 기록·토큰 사용량까지 된다. Codex·Gemini는 역할을 첫 지시에 담아 보낸다(시험판)
const ENGINES = {
  claude: { name: "Claude Code", bin: "claude", plan: (ask) => ["-p", ask, "--max-turns", "1"], full: true },
  codex: { name: "Codex", bin: "codex", plan: (ask) => ["exec", ask], full: false },
  gemini: { name: "Gemini CLI", bin: "gemini", plan: (ask) => ["-p", ask], full: false },
};

let cache = { at: 0, found: {} };
function detect(done) {
  if (Date.now() - cache.at < 60_000) return done(cache.found);
  const names = Object.values(ENGINES).map((e) => e.bin);
  // 각 이름마다 "이름<탭>경로" 한 줄. 없으면 경로가 빈다
  const script = names.map((n) => `printf '%s\\t%s\\n' ${n} "$(command -v ${n} 2>/dev/null)"`).join("; ");
  execFile("/bin/zsh", ["-lc", script], { timeout: 10_000 }, (err, out) => {
    const found = {};
    for (const line of String(out || "").split("\n")) {
      const [n, p] = line.split("\t");
      if (n && p && p.startsWith("/")) found[n] = p;
    }
    cache = { at: Date.now(), found };
    done(found);
  });
}

// 앱에 보낼 목록
function list(done) {
  detect((found) => done(Object.entries(ENGINES).map(([id, e]) => ({ id, name: e.name, installed: !!found[e.bin], full: e.full }))));
}

module.exports = { ENGINES, detect, list };
