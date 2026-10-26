// 팀원 claude 창의 토큰 사용량. 대화 기록(~/.claude/projects/<폴더>/<세션>.jsonl)의 응답마다 붙은 usage를 더한다.
// 기록은 계속 길어지므로 파일마다 읽은 자리까지 기억해 두고 새로 붙은 부분만 읽는다.
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const cache = new Map(); // 파일 → { offset, rest, ids:Set, input, output, cacheRead, cacheWrite }
const found = new Map(); // "폴더|이름" → { file, at } (기록 찾기는 1분에 한 번만)

// 이 컴퓨터 시간 기준 날짜 "2026-10-26"
function dayOf(t) {
  const d = t ? new Date(t) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Claude Code가 폴더 경로로 기록 폴더 이름을 만드는 방식 (글자·숫자 말고는 모두 -)
const projectDir = (cwd) => path.join(PROJECTS, cwd.replace(/[^A-Za-z0-9]/g, "-"));

function tally(file) {
  let c = cache.get(file);
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  if (!c || size < c.offset) { c = { offset: 0, rest: "", ids: new Set(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byDay: {} }; cache.set(file, c); }
  if (size > c.offset) {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - c.offset);
    fs.readSync(fd, buf, 0, buf.length, c.offset);
    fs.closeSync(fd);
    c.offset = size;
    const lines = (c.rest + buf.toString("utf8")).split("\n");
    c.rest = lines.pop();
    for (const l of lines) {
      if (!l.includes('"usage"')) continue;
      let d; try { d = JSON.parse(l); } catch { continue; }
      const m = d.message, u = m && m.usage;
      if (!u || d.type !== "assistant") continue;
      // 응답 하나가 내용 조각마다 여러 줄로 나뉘어 같은 usage가 반복된다 → 응답 번호로 한 번만 센다
      const id = m.id || d.uuid;
      if (c.ids.has(id)) continue;
      c.ids.add(id);
      c.input += u.input_tokens || 0;
      c.output += u.output_tokens || 0;
      c.cacheRead += u.cache_read_input_tokens || 0;
      c.cacheWrite += u.cache_creation_input_tokens || 0;
      // 날짜별 합계 (사용량 화면의 "오늘")
      const day = dayOf(d.timestamp);
      c.byDay[day] = (c.byDay[day] || 0) + (u.input_tokens || 0) + (u.output_tokens || 0)
        + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
  }
  return c;
}

// 이 폴더에서 이 이름(--name)으로 시작한 가장 최근 대화 기록. 세션 번호를 알면 그 파일을 바로 쓴다.
function findTranscript(cwd, title, sessionId) {
  const dir = projectDir(cwd);
  if (sessionId) return path.join(dir, sessionId + ".jsonl");
  const key = cwd + "|" + title, hit = found.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.file;
  const file = search(dir, title);
  found.set(key, { file, at: Date.now() });
  return file;
}

function search(dir, title) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return null; }
  const want = `"customTitle":${JSON.stringify(title)}`;
  const sorted = files.map((f) => path.join(dir, f))
    .map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 40);
  for (const { f } of sorted) {
    const fd = fs.openSync(f, "r");
    const buf = Buffer.alloc(Math.min(fs.statSync(f).size, 200_000));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (buf.toString("utf8").includes(want)) return f;
  }
  return null;
}

// 팀원들의 합계. total = 모델이 실제로 처리한 토큰(입력 + 캐시 쓰기·읽기 + 출력)
function team(cwd, members) {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const today = dayOf();
  let todayTotal = 0;
  const each = [];
  for (const m of members) {
    const f = findTranscript(cwd, m.title, m.sessionId);
    const c = f && tally(f);
    if (!c) { each.push(0); continue; }
    for (const k of Object.keys(sum)) sum[k] += c[k];
    todayTotal += c.byDay[today] || 0;
    each.push(c.input + c.output + c.cacheRead + c.cacheWrite);
  }
  return { ...sum, total: sum.input + sum.output + sum.cacheRead + sum.cacheWrite, today: todayTotal, each };
}

module.exports = { team };
