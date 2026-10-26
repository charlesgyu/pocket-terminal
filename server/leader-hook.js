// 팀장 창의 Claude Code Stop 훅. 팀장이 사장의 말에 답하고 차례를 마치면 그 답을 팀 대화방(board.md)에 올린다.
// 팀장이 post.sh 보고를 깜빡하고 터미널에만 답하면 앱 사무실에서는 답이 안 보이기 때문이다.
//   node leader-hook.js <board.md 경로> <팀장 이름>   (teams.js start()가 settings-1.json에 등록한다)
//   - 마지막 사람 말이 "[사장"으로 시작하면(앱에서 보낸 지시·결재·반려) 팀장의 마지막 답을 "보고"로 올린다.
//   - 사장이 팀장 창에 직접 친 말(앞에 [이름] 표시가 없는 말)이면 그 말을 "지시"로 먼저 올리고 답을 올린다.
//   - 그 차례에 팀장이 이미 post.sh 로 보고·말·결재요청을 남겼으면 겹치지 않게 아무것도 하지 않는다.
const fs = require("fs");

const [board, leader] = process.argv.slice(2);
const FIRST = "팀이 꾸려졌다."; // teams.js start()의 첫 지시
const ANSWERED = /post\.sh['"]?\s+(보고|말|결재요청|결재|반려)(?=\s|$)/;

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try { run(JSON.parse(input)); } catch {}
  process.exit(0);
});

function run(d) {
  if (!board || !leader || d.stop_hook_active) return;
  const lines = fs.readFileSync(d.transcript_path, "utf8").trim().split("\n");
  const msgs = [];
  for (const l of lines) { try { const x = JSON.parse(l); if (x.message && !x.isMeta) msgs.push(x.message); } catch {} }

  // 마지막 사람 말 (도구 결과는 건너뛴다)
  let i = msgs.length - 1, said = null;
  for (; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    const c = m.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "";
    if (Array.isArray(c) && c.some((b) => b.type === "tool_result")) continue;
    said = text.trim();
    break;
  }
  if (!said || said.startsWith(FIRST) || said.startsWith("<")) return;
  const fromBoss = said.startsWith("[사장");
  const typed = !said.startsWith("[");   // 팀원 말은 "[이름] ..."으로 온다
  if (!fromBoss && !typed) return;

  // 그 뒤 팀장의 말과 도구 사용
  let answer = "";
  for (const m of msgs.slice(i + 1)) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use" && ANSWERED.test(String(b.input?.command ?? JSON.stringify(b.input || {})))) return;
      if (b.type === "text" && b.text.trim()) answer = b.text;
    }
  }
  answer = clean(answer);
  if (!answer) return;
  if (typed) post("지시", "사장", clean(said));
  post("보고", leader, answer);
}

// 한 줄로 만들고, 끝의 토큰·시간 안내와 마크다운 굵게 표시를 뺀다
function clean(s) {
  return String(s)
    .split("\n").filter((l) => !/^\s*토큰 사용량/.test(l)).join("\n")
    .replace(/\*\*/g, "").replace(/\s*\n\s*/g, " ").trim().slice(0, 2000);
}

function post(kind, who, msg) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  fs.appendFileSync(board, `- [${stamp}][${kind}] ${who}: ${msg}\n`);
}
