#!/usr/bin/env node
/**
 * claude-agent-crews drift 감지
 *
 * 설치본(.claude/crews/*)과 템플릿을 비교해 재설치가 필요한지 판정한다.
 * 이 판정이 스크립트인 이유: 실행마다 결과가 달라지면 버그다.
 * 그리고 drift 감지 자체는 비용이 아니라 **변경 동의 메커니즘**이다 — 생성물을
 * 심볼릭 링크로 바꿔 이 단계를 없애지 말 것 — 그러면 pull 한 번에 모든 레포의
 * 에이전트 행동이 조용히 바뀐다.
 *
 * 비교 규격 (이 스크립트가 단일 출처):
 *   - 매니페스트의 "소유" 컬럼이 `템플릿`인 파일만 비교한다.
 *     `프로젝트` 소유 파일(run-profile, crews-config)은 사용자가 채우는 파일이라 drift가 아니다.
 *   - MEASURED 블록(<!-- MEASURED:START --> ~ <!-- MEASURED:END -->)은 비교에서 제외한다.
 *     프로젝트마다 다른 측정값이므로 다른 것이 정상이다.
 *   - gitignore 기대 목록은 매니페스트의 템플릿 소유 파일에서 유도한다.
 *
 * 사용법:
 *   node ~/.claude/skills/crews-setup/scripts/drift.mjs [--json] [프로젝트경로]
 *
 * exit code: 0 = 판정 완료(상태는 출력 참조), 1 = 오류
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates')
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const PROJECT = path.resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd())

const read = (p) => (fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null)

const out = {
  status: 'fresh', // fresh | ok | unknown-domain
  domain: null,
  drift: [], // 템플릿 소유 파일 중 내용이 다른 것
  missing: [], // 설치돼야 하는데 없는 파일
  preserved: [], // 프로젝트 소유 — 비교하지 않음
  gitignoreMissing: [],
  codexDivergence: null,
  notes: [],
}

const finish = () => {
  if (asJson) {
    console.log(JSON.stringify(out, null, 2))
  } else {
    const L = [`상태: ${out.status}`, `도메인: ${out.domain ?? '(미확인)'}`]
    L.push(`템플릿 파일 drift: ${out.drift.length ? '' : '없음'}`)
    for (const f of out.drift) L.push(`  - ${f}`)
    if (out.missing.length) {
      L.push('누락된 파일:')
      for (const f of out.missing) L.push(`  - ${f}`)
    }
    if (out.preserved.length) L.push(`보존(프로젝트 소유): ${out.preserved.join(', ')}`)
    L.push(`gitignore 누락: ${out.gitignoreMissing.length ? out.gitignoreMissing.join(', ') : '없음'}`)
    if (out.codexDivergence) L.push(`codex 공존: ${out.codexDivergence}`)
    if (out.notes.length) {
      L.push('※')
      for (const n of out.notes) L.push(`  - ${n}`)
    }
    console.log(L.join('\n'))
  }
  process.exit(0)
}

// ---------- 0. GENERATED.md → 도메인 ----------
// 최초 설치(GENERATED.md 없음)에도 매니페스트·gitignore 기대 목록은 필요하다.
// 그래서 도메인을 인자로 받는다 — 이게 없으면 fresh에서 gitignore 항목이 조용히 누락된다
// (게이트 검증에서 실제로 발견된 결함).
const domainArg = args.find((a) => a.startsWith('--domain='))?.split('=')[1] ?? null
const generated = read(path.join(PROJECT, '.claude/crews/GENERATED.md'))

if (!generated && !domainArg) {
  out.notes.push(
    '.claude/crews/GENERATED.md 없음 — 최초 설치. gitignore/매니페스트까지 판정하려면 --domain={도메인}을 넘길 것',
  )
  finish()
}

if (generated) {
  const domainMatch = generated.match(/^도메인:\s*(\S+)/m)
  if (!domainMatch) {
    out.status = 'unknown-domain'
    out.notes.push('GENERATED.md에서 "도메인:" 줄을 찾지 못했다 — 재설치로 재생성 필요')
    finish()
  }
  out.domain = domainMatch[1]
  if (domainArg && domainArg !== out.domain) {
    out.notes.push(`인자 도메인(${domainArg})과 기록된 도메인(${out.domain})이 다르다 — 기록을 기준으로 판정함`)
  }
} else {
  out.domain = domainArg
  out.notes.push(`최초 설치 — 인자로 받은 도메인(${domainArg}) 기준으로 매니페스트/gitignore만 판정`)
}

const profileSrc = path.join(TEMPLATES, `domains/${out.domain}/stack-profile.md`)
const profileText = read(profileSrc)
if (!profileText) {
  out.status = 'unknown-domain'
  out.notes.push(`템플릿에 도메인이 없다: domains/${out.domain}/ — 레포가 옮겨졌거나 도메인이 제거됨`)
  finish()
}

// ---------- 1. 매니페스트 파싱 ----------
// | `.claude/crews/x.md` | `common/x.md` | 템플릿 |
const manifest = []
const section = profileText.split(/^##\s+설치 매니페스트\s*$/m)[1]
if (!section) {
  out.notes.push('템플릿 stack-profile.md에 "설치 매니페스트" 섹션이 없다')
  finish()
}
for (const line of section.split('\n')) {
  const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*(템플릿|프로젝트)\s*\|/)
  if (m) manifest.push({ target: m[1], source: m[2], owner: m[3] })
}
if (manifest.length === 0) {
  out.notes.push('매니페스트 표에서 행을 읽지 못했다 (표기 규격: | `대상` | `소스` | 소유 |)')
  finish()
}

// ---------- 2. 비교 ----------
const stripMeasured = (text) =>
  text.replace(/<!-- MEASURED:START[\s\S]*?<!-- MEASURED:END -->/g, '<!-- MEASURED -->')
const normalize = (text) => stripMeasured(text).replace(/\s+$/g, '')

// GENERATED.md가 없으면 상태는 여전히 fresh다 — 아래 비교는 gitignore/누락 파악용이다
out.status = generated ? 'ok' : 'fresh'
for (const entry of manifest) {
  const dst = read(path.join(PROJECT, entry.target))
  if (dst === null) {
    out.missing.push(entry.target)
    continue
  }
  if (entry.owner === '프로젝트') {
    out.preserved.push(entry.target)
    continue
  }
  const src = read(path.join(TEMPLATES, entry.source))
  if (src === null) {
    out.notes.push(`템플릿 소스 없음: ${entry.source}`)
    continue
  }
  if (normalize(src) !== normalize(dst)) out.drift.push(entry.target)
}

// ---------- 3. gitignore (템플릿 소유 파일에서 유도) ----------
// 판정은 `git check-ignore`에 맡긴다. 줄 단위 문자열 비교로는 디렉토리 단위 무시
// (`.claude/crews/`)가 이미 커버하는 파일을 "누락"으로 오탐한다 — 실제로 발생했다.
// git이 없거나 저장소가 아니면 줄 비교로 내려간다(그 경우 오탐 가능성을 note에 남긴다).
const expected = [...new Set([...manifest.filter((e) => e.owner === '템플릿').map((e) => e.target), '.claude/crews/GENERATED.md'])]

const checkIgnoreByGit = (paths) => {
  try {
    const res = spawnSync('git', ['-C', PROJECT, 'check-ignore', '--', ...paths], { encoding: 'utf8' })
    // exit 0 = 하나 이상 무시됨(무시된 경로만 출력), 1 = 무시된 것 없음, 128 = 저장소 아님 등
    if (res.error || res.status === null || res.status > 1) return null
    const ignored = new Set(res.stdout.split('\n').map((l) => l.trim()).filter(Boolean))
    return paths.filter((p) => !ignored.has(p))
  } catch {
    return null
  }
}

const byGit = checkIgnoreByGit(expected)
if (byGit) {
  out.gitignoreMissing = byGit
} else {
  const lines = new Set((read(path.join(PROJECT, '.gitignore')) ?? '').split('\n').map((l) => l.trim()))
  out.gitignoreMissing = expected.filter((e) => !lines.has(e))
  if (out.gitignoreMissing.length) {
    out.notes.push('git check-ignore를 쓸 수 없어 줄 단위로 비교했다 — 디렉토리 단위 무시가 있으면 오탐일 수 있다')
  }
}

// ---------- 4. codex 공존 divergence ----------
// 분리(split) 모드를 선택한 프로젝트에서는 이 경고가 유일한 안전장치다.
// "둘 다 있다"는 사실만 알리면 매번 같은 소리라 무시된다 → **수정 시각을 비교해 갱신 방향을 알린다.**
const mtime = (rel) => {
  const full = path.join(PROJECT, rel)
  return fs.existsSync(full) ? fs.statSync(full).mtimeMs : null
}
const codexMtime = mtime('.codex/stack-profile.md')
if (codexMtime !== null) {
  const claudeMtime = mtime('.claude/crews/stack-profile.md')
  const day = (ms) => new Date(ms).toISOString().slice(0, 10)
  if (claudeMtime === null) {
    out.codexDivergence = '.codex/stack-profile.md만 존재 (참조 모드로 보임)'
  } else if (codexMtime > claudeMtime) {
    const gap = Math.round((codexMtime - claudeMtime) / 86400000)
    out.codexDivergence =
      `⚠️ .codex/stack-profile.md(${day(codexMtime)})가 .claude/crews/stack-profile.md(${day(claudeMtime)})보다 ` +
      `나중에 수정됨 (${gap}일 차). codex 쪽에서 갱신된 스택 사실이 claude 쪽에 반영되지 않았을 수 있다 — ` +
      `두 파일을 대조하고, 필요하면 도메인 템플릿에 반영해 /crews-setup을 다시 실행할 것`
  } else {
    out.codexDivergence = `공존(분리) — claude 쪽이 더 최신(${day(claudeMtime)}). 사실이 어긋나지 않았는지는 대조로만 확인된다`
  }
}

finish()
