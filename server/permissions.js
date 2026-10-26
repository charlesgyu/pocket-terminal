// Claude Code 권한 요청을 폰으로도 보낸다.
// 이 컴퓨터의 Claude Code가 "실행해도 될까요?"를 물으면 PermissionRequest 훅(permission-hook.js)이
// 여기로 요청을 넘기고 답을 기다린다. 컴퓨터 화면의 질문 창은 그대로 떠 있어서, 폰과 컴퓨터 중 먼저 답한 쪽이 이긴다.
//   폰이 먼저: 훅이 allow/deny를 돌려주고 컴퓨터의 질문 창이 닫힌다
//   컴퓨터가 먼저: 훅이 그걸 알아채고 요청을 끊는다 → 여기서 지우고 폰 알림도 내린다
const crypto = require("crypto");
const path = require("path");
const { EventEmitter } = require("events");

const events = new EventEmitter();
events.setMaxListeners(0);
const waiting = new Map(); // 번호 → { info, reply(decision) }

// 폰에 보여 줄 한 줄 요약
function summary(tool, input = {}) {
  const s = input.command || input.file_path || input.notebook_path || input.url || input.pattern || input.description || "";
  return String(s).slice(0, 600);
}

// 훅이 보낸 요청을 받아 답(allow|deny)이 오거나 연결이 끊길 때까지 붙잡아 둔다
function hold(req, res, d) {
  const id = crypto.randomBytes(8).toString("hex");
  const info = {
    id,
    project: path.basename(String(d.cwd || "")) || "?",
    tool: String(d.tool_name || "?").slice(0, 60),
    summary: summary(d.tool_name, d.tool_input),
    description: String((d.tool_input && d.tool_input.description) || "").slice(0, 200),
    at: Date.now(),
  };
  const finish = (decision) => {
    if (!waiting.has(id)) return;
    waiting.delete(id);
    events.emit("change");
    if (!res.writableEnded) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ decision }));
    }
  };
  waiting.set(id, { info, finish });
  console.log(new Date().toISOString(), "권한 요청", info.project, info.tool);
  require("./push").notify({ title: `Claude가 허락을 구합니다 · ${info.project}`, body: `${info.tool} · 내용은 앱에서 확인하세요`, // 명령 원문은 잠금화면·Apple 서버에 싣지 않는다
    category: "PERM", data: { perm: id }, collapse: `perm-${id}` });
  events.emit("change");
  // 훅이 끝나면(컴퓨터에서 먼저 답함, 시간 초과) 폰 알림을 내린다
  res.on("close", () => finish(null));
}

function list() {
  return [...waiting.values()].map((w) => w.info).sort((a, b) => a.at - b.at);
}

function answer(id, allow, byName) {
  const w = waiting.get(id);
  if (!w) return false;
  console.log(new Date().toISOString(), "폰에서 권한 답함", byName || "?", allow ? "허용" : "거절", w.info.tool);
  w.finish(allow ? "allow" : "deny");
  return true;
}

module.exports = { hold, list, answer, events };
