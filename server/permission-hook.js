// Claude Code PermissionRequest 훅. Claude가 권한을 물을 때 포켓 터미널 서버로 넘겨 폰에서도 답하게 한다.
// ~/.claude/settings.json 에 pt.sh setup 이 등록한다. 컴퓨터의 질문 창은 그대로 뜬다.
//   폰에서 답하면 → allow/deny를 Claude Code에 돌려준다 (컴퓨터 질문 창이 닫힘)
//   컴퓨터에서 먼저 답하면 → 대화 기록 파일이 늘어나는 것으로 알아채고 서버 요청을 끊는다 (폰 알림이 내려감)
//   서버가 꺼져 있거나 연결한 폰이 없으면 → 아무 답 없이 바로 끝난다 (평소처럼 컴퓨터에서만 묻는다)
const fs = require("fs");
const http = require("http");
const path = require("path");

const HOME = process.env.PT_HOME || path.join(require("os").homedir(), ".pocket-terminal");
const PORT = Number(process.env.PT_PORT || 8790);

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let d, token;
  try { d = JSON.parse(input); token = fs.readFileSync(path.join(HOME, "token"), "utf8").trim(); } catch { process.exit(0); }
  const size = () => { try { return fs.statSync(d.transcript_path).size; } catch { return -1; } };
  // 훅이 시작된 직후에도 Claude Code가 기록을 한 번 더 쓰므로, 처음 2초 동안은 기준만 새로 잡는다
  let start = size();
  const began = Date.now();
  const parent = process.ppid;
  const body = JSON.stringify({ cwd: d.cwd, tool_name: d.tool_name, tool_input: d.tool_input, session_id: d.session_id });
  const req = http.request({ host: "127.0.0.1", port: PORT, path: "/hook/permission", method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } }, (res) => {
    let out = "";
    res.on("data", (c) => (out += c));
    res.on("end", () => {
      let decision = null;
      try { decision = JSON.parse(out).decision; } catch {}
      if (decision === "allow" || decision === "deny") {
        const dec = decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "사용자가 휴대폰에서 거절했습니다." };
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: dec } }));
      }
      process.exit(0);
    });
  });
  req.on("error", () => process.exit(0));
  req.end(body);
  // 컴퓨터에서 먼저 답하면 대화 기록에 결과가 붙는다 → 폰 쪽 요청을 거둔다
  // (컴퓨터에서 답하면 결과와 이어지는 Claude 답이 계속 붙으므로 2초 뒤에도 반드시 늘어난다)
  setInterval(() => {
    const now = size();
    if (Date.now() - began < 2000) { start = now; return; }
    if (now !== start) { req.destroy(); process.exit(0); }
    // Claude Code가 꺼지면(창을 닫음) 부모가 바뀐다 → 폰 알림을 거둔다
    if (process.ppid !== parent) { req.destroy(); process.exit(0); }
  }, 500);
});
