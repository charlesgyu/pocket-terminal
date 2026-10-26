// 팀 게시판을 지켜보다가 폰에 알린다 (앱을 닫아도 오는 알림, push.js).
//   팀장이 사장에게 결재 요청 → "결재 요청" 알림 (누르면 그 팀 사무실)
//   진척 100 → "일을 마쳤습니다" 알림
//   진척률이 바뀌거나 1분마다 → 잠금화면 진척 표시(라이브 액티비티) 갱신
// 서버가 켜질 때 이미 있던 글로는 알리지 않는다 (게시판 끝부터 새로 붙는 줄만 본다).
const fs = require("fs");
const path = require("path");
const os = require("os");
const push = require("./push");
const teams = require("./teams");

const ROOT = path.join(os.homedir(), ".pocket-terminal", "teams");
const seen = new Map(); // 팀 id → 읽은 바이트 수
const lastState = new Map(); // 팀 id → 마지막으로 보낸 잠금화면 내용(JSON)

function scan(tmux, running) {
  let ids = [];
  try { ids = fs.readdirSync(ROOT).filter((d) => /^t[a-z0-9]{4,12}$/.test(d)); } catch { return; }
  for (const id of ids) {
    const f = path.join(ROOT, id, "board.md");
    let size;
    try { size = fs.statSync(f).size; } catch { continue; }
    const from = seen.get(id);
    seen.set(id, size);
    if (from === undefined || size <= from) continue;
    const fd = fs.openSync(f, "r");
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    const team = teams.list(running).find((t) => t.id === id);
    const name = team ? team.name : id;
    for (const line of buf.toString("utf8").split("\n")) {
      const m = line.match(/^- \[[^\]]+\]\[([^\]]+)\] ([^:]+): (.*)$/);
      if (!m) continue;
      const [, kind, who, text] = m;
      if (kind === "결재요청" && text.includes("사장")) {
        push.notify({ title: `${name} · ${who.trim()}님의 결재 요청`, body: text.slice(0, 300), category: "TEAM", data: { team: id }, collapse: `ask-${id}` });
      } else if (kind === "진척" && /^\s*100\b/.test(text)) {
        push.notify({ title: `${name} · 일을 마쳤습니다`, body: text.replace(/^\s*100\s*%?\s*/, "").slice(0, 300), category: "TEAM", data: { team: id } });
      }
    }
  }
  // 잠금화면 진척 표시: 내용이 바뀐 팀만 보낸다
  for (const t of teams.list(running)) {
    const s = teams.status(t.id, tmux);
    if (!s) continue;
    const working = s.members.filter((m) => m.state === "working").length;
    const off = !s.members.some((m) => m.state !== "off");
    const state = {
      percent: s.progress ? s.progress.percent : -1, note: s.progress ? s.progress.note : "",
      started: s.started || 0, tokens: s.tokens || 0, working, members: s.members.length,
    };
    const key = JSON.stringify({ ...state, tokens: Math.round(state.tokens / 1e5) });
    if (lastState.get(t.id) === key) continue;
    lastState.set(t.id, key);
    push.updateActivity(t.id, state, off);
  }
}

function start(tmux, runningSet) {
  scan(tmux, runningSet()); // 처음에는 읽은 자리만 잡는다
  setInterval(() => { try { scan(tmux, runningSet()); } catch (e) { console.log("팀 알림 확인 실패", e.message); } }, 20_000).unref();
}

module.exports = { start };
