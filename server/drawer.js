// 팀 사무실 서랍: 팀이 만든 것을 한곳에 모아 보여 준다.
//   GET /teams/<id>/drawer → { goal: [파일], groups: [{ name, files: [파일] }], links: [{ url, who, time }] }
//   파일 = { path(실제 경로, GET /files로 연다), name(작업 폴더 안 경로), size, mtime }
// 어느 폴더를 볼지는 게시판에 나온 파일 경로로 정한다("failed-company-lab/ep03/대본.md" → failed-company-lab).
// 목표 결과물: final·완성본 폴더 안 파일과 영상(게시판에 나온 외장하드 완성본 폴더 포함).
// 아티팩트: 나머지(대본·조사노트·이미지 등)와 게시판의 Claude 아티팩트 링크.
const fs = require("fs");
const path = require("path");
const { WORKDIR } = require("./config");
const files = require("./files");

const PATH_RE = /((?:~|\/Volumes\/[^/\s]+)\/클로드 전용 폴더\/)?[\p{L}\p{N}_./-]+\.(md|txt|json|csv|srt|vtt|html|png|jpg|jpeg|gif|webp|heic|mp4|mov|m4v|mp3|m4a|wav|pdf)(?![\p{L}\p{N}])/giu;
const LINK_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/g;
const SKIP_DIRS = new Set(["node_modules", "work", "audio", "raw", "src", "voice-test"]); // 중간 작업물·원본 녹음
const VIDEO = new Set([".mp4", ".mov", ".m4v"]);
const MAX_FILES = 400;
// 보여 줄 것: 글·그림·영상·소리·PDF. 코드와 설정, 작업 규칙(CLAUDE.md)은 뺀다
const SHOW = new Set([".md", ".txt", ".csv", ".srt", ".vtt", ".html", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic",
  ".mp4", ".mov", ".m4v", ".mp3", ".m4a", ".wav", ".pdf"]);

function walk(dir, out, depth = 0) {
  if (depth > 4 || out.length >= MAX_FILES) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith(".") || e.name.includes("API키")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out, depth + 1); }
    else if (e.isFile() && SHOW.has(path.extname(e.name).toLowerCase()) && e.name !== "CLAUDE.md") out.push(p);
    if (out.length >= MAX_FILES) return;
  }
}

function drawer(board, teamFolder) {
  const root = fs.realpathSync(WORKDIR);
  // 게시판에 나온 경로 중 폴더가 붙은 것만으로 작업 폴더(베이스캠프 바로 아래)를 찾는다. "SCRIPT.md"만으로는 어디인지 모른다
  const projects = new Set(), finals = new Set();
  for (const m of board.matchAll(PATH_RE)) {
    const said = m[0].replace(/^~\/클로드 전용 폴더\//, "");
    if (!said.includes("/")) continue;
    const real = files.resolve(m[0], teamFolder);
    if (!real) continue;
    // 베이스캠프 밖(외장하드)의 완성본 폴더는 그 폴더만 목표 결과물로 본다
    if (path.relative(root, real).startsWith("..")) {
      if (real.split(path.sep).includes("완성본")) finals.add(path.dirname(real));
      continue;
    }
    // 글에 적힌 첫 폴더가 실제 작업 폴더일 때만 (짧은 경로가 엉뚱한 프로젝트로 풀리는 것을 막는다)
    const top = path.relative(root, real).split(path.sep)[0];
    if (top && top !== path.basename(real) && said.split("/")[0] === top) projects.add(top);
  }
  const goal = [], groups = new Map();
  for (const top of projects) {
    const found = [];
    walk(path.join(root, top), found);
    for (const f of found) {
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      const inner = path.relative(path.join(root, top), f);
      const item = { path: f, name: inner, size: st.size, mtime: Math.round(st.mtimeMs / 1000) };
      const parts = inner.split(path.sep);
      if (parts.some((p) => p === "final" || p === "완성본") || VIDEO.has(path.extname(f).toLowerCase())) { goal.push(item); continue; }
      // 묶음: 작업 폴더 안 첫 폴더(ep03 등). 맨 위 파일은 작업 폴더 이름으로
      const g = parts.length > 1 ? `${top}/${parts[0]}` : top;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(item);
    }
  }
  for (const dir of finals) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const f = path.join(dir, n);
      if (n.startsWith(".") || !SHOW.has(path.extname(n).toLowerCase())) continue;
      try {
        const st = fs.statSync(f);
        if (st.isFile()) goal.push({ path: f, name: `완성본/${path.basename(dir)}/${n}`, size: st.size, mtime: Math.round(st.mtimeMs / 1000) });
      } catch {}
    }
  }
  const newest = (a, b) => b.mtime - a.mtime;
  const links = [];
  const seen = new Set();
  for (const line of board.split("\n").reverse()) {
    const who = (line.match(/^- \[([^\]]+)\]\[[^\]]+\] ([^:]+):/) || [])[2] || "";
    const time = (line.match(/^- \[([^\]]+)\]/) || [])[1] || "";
    for (const url of line.match(LINK_RE) || []) if (!seen.has(url)) { seen.add(url); links.push({ url, who: who.trim(), time }); }
  }
  return {
    goal: goal.sort(newest),
    // 최근에 손댄 묶음이 위로
    groups: [...groups].map(([name, fs_]) => ({ name, files: fs_.sort(newest) }))
      .sort((a, b) => b.files[0].mtime - a.files[0].mtime),
    links,
  };
}

module.exports = { drawer };
