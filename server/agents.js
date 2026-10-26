// Claude Code 에이전트(하위 에이전트) 관리: ~/.claude/agents/<이름>.md 파일을 읽고 쓴다.
// 파일 모양: --- 앞머리(name, description, tools, model) --- 다음에 에이전트에게 주는 지시문.
// 지우기는 파일을 ~/.claude/backups/지운 에이전트/<날짜>/ 로 옮긴다 (되살릴 수 있게).
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = path.join(os.homedir(), ".claude", "agents");
const TRASH = path.join(os.homedir(), ".claude", "backups", "지운 에이전트");
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MODELS = ["", "inherit", "sonnet", "opus", "haiku", "fable"];

function parse(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { prompt: text };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { ...meta, prompt: m[2].trim() };
}

// 한 줄 값은 줄바꿈을 빼고 그대로 쓴다 (description에 콜론이 있어도 Claude Code가 읽는다)
const oneLine = (s) => String(s || "").replace(/\s*\n\s*/g, " ").trim();

function serialize(a) {
  const lines = [`name: ${a.name}`, `description: ${oneLine(a.description)}`];
  if (oneLine(a.tools)) lines.push(`tools: ${oneLine(a.tools)}`);
  if (oneLine(a.model)) lines.push(`model: ${oneLine(a.model)}`);
  return `---\n${lines.join("\n")}\n---\n\n${String(a.prompt || "").trim()}\n`;
}

function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith(".md")).sort().map((f) => {
    const p = path.join(DIR, f);
    const a = parse(fs.readFileSync(p, "utf8"));
    return { name: a.name || f.slice(0, -3), description: a.description || "", tools: a.tools || "",
             model: a.model || "", prompt: a.prompt || "", modified: fs.statSync(p).mtimeMs };
  });
}

// 만들기·고치기. 잘못된 값이면 오류 문구를 돌려준다.
function save(name, body) {
  if (!NAME_RE.test(name)) return "이름은 영문 소문자·숫자·하이픈(-)만, 48자 이내로 써 주세요.";
  if (!oneLine(body.description)) return "설명(언제 이 에이전트를 쓰는지)을 써 주세요.";
  if (!String(body.prompt || "").trim()) return "지시문을 써 주세요.";
  if (!MODELS.includes(oneLine(body.model))) return "모델은 비우거나 inherit, sonnet, opus, haiku, fable 중 하나여야 합니다.";
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, name + ".md");
  // 고칠 때도 옛 내용은 백업해 둔다
  if (fs.existsSync(file)) backup(file);
  fs.writeFileSync(file, serialize({ ...body, name }));
  return null;
}

function backup(file) {
  const day = new Date().toISOString().slice(0, 10);
  const dest = path.join(TRASH, day);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(file, path.join(dest, `${path.basename(file, ".md")}-${Date.now()}.md`));
}

function remove(name) {
  if (!NAME_RE.test(name)) return false;
  const file = path.join(DIR, name + ".md");
  if (!fs.existsSync(file)) return false;
  backup(file);
  fs.unlinkSync(file);
  return true;
}

module.exports = { list, save, remove, NAME_RE };
