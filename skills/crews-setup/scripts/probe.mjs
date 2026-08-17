#!/usr/bin/env node
/**
 * claude-agent-crews 프로젝트 측정기
 *
 * 도메인 감지 + 프로파일의 MEASURED 블록에 들어갈 사실을 프로젝트에서 직접 읽어 출력한다.
 * 이 스크립트가 있는 이유: "실행마다 결과가 달라지면 버그"인 작업은
 * 프롬프트가 아니라 스크립트가 해야 한다. 경로·보드명·명령을 모델이 추측하면 프로파일이
 * 맥락이 아니라 소설이 된다.
 *
 * 사용법:
 *   node scripts/probe.mjs [프로젝트경로]            사람이 읽는 요약
 *   node scripts/probe.mjs --json [경로]            crews-setup이 소비하는 JSON
 *   node scripts/probe.mjs --measured=stack [경로]   stack-profile MEASURED 블록 본문
 *   node scripts/probe.mjs --measured=run [경로]     run-profile MEASURED 블록 본문
 *
 * MEASURED 블록의 **서식까지** 이 스크립트가 만든다. 프롬프트에 서식을 지정하면
 * 실행마다 표가 달라지고, 그건 drift 비교에서 노이즈가 된다.
 *
 * exit code: 0 = 도메인 감지 성공, 2 = 미지원 도메인(설치 불가), 1 = 오류
 */

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const measuredKind = args.find((a) => a.startsWith('--measured'))?.split('=')[1] ?? null
const ROOT = path.resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd())
const today = new Date().toISOString().slice(0, 10)

const read = (rel) => {
  const full = path.join(ROOT, rel)
  return fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8') : null
}
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))
const dirs = (rel) => {
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) return []
  return fs
    .readdirSync(full, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
}
const files = (rel) => {
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) return []
  return fs
    .readdirSync(full, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
}

// ---------- INI 파싱 (platformio.ini) ----------
// 섹션 [name], `key = value`, 그리고 들여쓴 연속 줄(멀티라인 값)을 처리한다.
const parseIni = (text) => {
  const sections = {}
  let current = null
  let lastKey = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
      // 섹션 첫 주석은 사람이 남긴 설명이라 보존 가치가 있다
      if (current && trimmed && !sections[current]._comment) {
        sections[current]._comment = trimmed.replace(/^[;#]\s*/, '')
      }
      continue
    }
    const section = trimmed.match(/^\[([^\]]+)\]$/)
    if (section) {
      current = section[1]
      sections[current] ??= {}
      lastKey = null
      continue
    }
    if (!current) continue
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/)
    if (kv) {
      lastKey = kv[1]
      sections[current][lastKey] = kv[2].trim()
    } else if (lastKey && /^\s/.test(line)) {
      sections[current][lastKey] = `${sections[current][lastKey]}\n${trimmed}`.trim()
    }
  }
  return sections
}
const multi = (value) =>
  (value ?? '')
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean)

// ---------- 도메인 감지 ----------
const pkg = (() => {
  const text = read('package.json')
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
})()
const dep = (name) => Boolean(pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name])

let domain = null
let confidence = null
const notes = []

if (exists('platformio.ini')) {
  domain = 'embedded-platformio'
  confidence = 'certain'
} else if (dep('next')) {
  domain = 'web-next'
  confidence = 'certain'
} else if (dep('vite') && (dep('react') || dep('react-dom'))) {
  domain = 'web-vite-react'
  confidence = 'certain'
}
// Phase 0에서 템플릿이 있는 도메인은 embedded-platformio 하나다. 나머지는 감지되더라도 미구현.
const IMPLEMENTED = new Set(['embedded-platformio'])

// ---------- 도메인별 측정 ----------
const measured = {}

if (domain === 'embedded-platformio') {
  const ini = parseIni(read('platformio.ini') ?? '')
  const base = ini['env'] ?? {}
  const envNames = Object.keys(ini).filter((s) => s.startsWith('env:'))
  measured.platform = base.platform ?? null
  measured.framework = base.framework ?? null
  measured.defaultEnvs = multi(ini['platformio']?.default_envs ?? '').flatMap((v) => v.split(/[,\s]+/)).filter(Boolean)
  measured.envs = envNames.map((section) => {
    const env = ini[section]
    return {
      name: section.slice(4),
      board: env.board ?? null,
      note: env._comment ?? null,
      platform: env.platform ?? measured.platform,
      framework: env.framework ?? measured.framework,
      monitorSpeed: env.monitor_speed ?? base.monitor_speed ?? null,
      buildSrcFilter: env.build_src_filter ?? env.src_filter ?? null,
      buildFlags: multi(env.build_flags),
      libDeps: multi(env.lib_deps),
    }
  })
  measured.srcDirs = dirs('src')
  measured.includeFiles = files('include')
  measured.testDirs = dirs('test')
  measured.docs = files('docs')
  // 예시 설정 헤더 ↔ 실제 설정 헤더 쌍 (시크릿이 로컬에만 있어야 하는 지점)
  measured.configPairs = files('include')
    .filter((f) => /\.example\.(h|hpp)$/.test(f))
    .map((f) => ({ example: `include/${f}`, actual: `include/${f.replace(/\.example(\.h|\.hpp)$/, '$1')}` }))
  // 동반 노드 프로세스(게이트웨이 등) — 펌웨어만으로 끝나지 않는 프로젝트가 많다
  measured.companions = []
  for (const d of dirs('.')) {
    if (d === 'src' || d === 'include' || d === 'test' || d === 'docs') continue
    const sub = read(path.join(d, 'package.json'))
    if (!sub) continue
    try {
      const parsed = JSON.parse(sub)
      measured.companions.push({ dir: d, scripts: Object.keys(parsed.scripts ?? {}), main: parsed.main ?? null })
    } catch {
      notes.push(`${d}/package.json 파싱 실패 — 무시함`)
    }
  }
  measured.deployFiles = files('deploy')
  if (measured.envs.length === 0) notes.push('platformio.ini에 [env:*] 섹션이 없다 — 빌드 대상 미정')
  if (measured.envs.some((e) => !e.board)) notes.push('board가 지정되지 않은 env가 있다')
}

// ---------- 공존 / 설치 상태 ----------
const claudeMd = read('CLAUDE.md')
const coexistence = {
  codexStackProfile: exists('.codex/stack-profile.md'),
  codexFiles: exists('.codex') ? files('.codex') : [],
  claudeCrews: exists('.claude/crews'),
  claudeCrewsFiles: exists('.claude/crews') ? files('.claude/crews') : [],
  claudeContext: exists('.claude/CONTEXT.md'),
  claudeMd: Boolean(claudeMd),
  agentsMd: exists('AGENTS.md'),
  markerBlocks: (claudeMd?.match(/<!-- CREWS-START -->/g) ?? []).length,
}
if (coexistence.codexStackProfile) {
  notes.push('.codex/stack-profile.md 존재 — 같은 사실의 진실 공급원이 둘이 되지 않도록 공존 선택 필요')
}
if (!coexistence.claudeMd && coexistence.agentsMd) {
  notes.push('CLAUDE.md 없고 AGENTS.md만 있음 — CLAUDE.md를 만들고 AGENTS.md를 읽으라는 줄을 넣는다')
}

// ---------- gitignore 기대 목록 ----------
// 소유 모델(DESIGN 확장): 템플릿이 재생성할 수 있는 것만 gitignore한다.
// 손으로 쌓는 것(journal/lessons/evidence/plans)과 사용자 편집 파일(crews-config, run-profile)은 커밋 대상.
const GITIGNORE_EXPECTED = [
  '.claude/crews/stack-profile.md',
  '.claude/crews/crews-routing.md',
  '.claude/crews/GENERATED.md',
]
const gitignoreText = read('.gitignore') ?? ''
const gitignoreLines = new Set(gitignoreText.split('\n').map((l) => l.trim()))
const gitignore = {
  present: Boolean(read('.gitignore')),
  expected: GITIGNORE_EXPECTED,
  missing: GITIGNORE_EXPECTED.filter((e) => !gitignoreLines.has(e)),
}

// ---------- 출력 ----------
const result = {
  root: ROOT,
  name: pkg?.name ?? path.basename(ROOT),
  domain,
  domainImplemented: domain ? IMPLEMENTED.has(domain) : false,
  confidence,
  measured,
  coexistence,
  gitignore,
  notes,
}

// ---------- MEASURED 블록 렌더링 ----------
const renderMeasured = (kind) => {
  if (domain !== 'embedded-platformio') return null
  const L = []
  if (kind === 'stack') {
    L.push(`### 측정값 — \`platformio.ini\` (측정: ${today})`)
    L.push('')
    L.push(`- platform: \`${measured.platform ?? '-'}\` · framework: \`${measured.framework ?? '-'}\``)
    L.push(`- 기본 env: ${measured.defaultEnvs.map((e) => `\`${e}\``).join(', ') || '(지정 없음 — 전체 빌드)'}`)
    L.push('')
    L.push('| env | board | monitor | 소스 필터 | lib_deps |')
    L.push('|---|---|---|---|---|')
    for (const e of measured.envs) {
      const filter = e.buildSrcFilter ? `\`${e.buildSrcFilter.replace(/\s+/g, ' ')}\`` : '(전체)'
      L.push(
        `| \`${e.name}\`${e.note ? ` — ${e.note}` : ''} | \`${e.board ?? '-'}\` | ${e.monitorSpeed ?? '-'} | ${filter} | ${e.libDeps.length || '-'} |`,
      )
    }
    L.push('')
    L.push(`- \`src/\` 하위: ${measured.srcDirs.map((d) => `\`${d}/\``).join(', ') || '(없음)'}`)
    L.push(`- \`include/\`: ${measured.includeFiles.map((f) => `\`${f}\``).join(', ') || '(없음)'}`)
    if (measured.configPairs.length) {
      L.push(
        `- 설정 쌍(시크릿 경계): ${measured.configPairs.map((p) => `\`${p.example}\` → \`${p.actual}\``).join(', ')}`,
      )
    }
    if (measured.companions.length) {
      L.push(
        `- 동반 프로세스: ${measured.companions.map((c) => `\`${c.dir}/\` (scripts: ${c.scripts.join(', ') || '없음'})`).join(', ')}`,
      )
    }
    if (measured.deployFiles.length) L.push(`- \`deploy/\`: ${measured.deployFiles.map((f) => `\`${f}\``).join(', ')}`)
    if (measured.testDirs.length) L.push(`- \`test/\`: ${measured.testDirs.join(', ')}`)
    if (measured.docs.length) L.push(`- \`docs/\`: ${measured.docs.map((f) => `\`${f}\``).join(', ')}`)
    return L.join('\n')
  }
  if (kind === 'run') {
    L.push(`### 명령 — 측정값에서 유도 (측정: ${today})`)
    L.push('')
    L.push('| env | 빌드 | 업로드 | 시리얼 모니터 |')
    L.push('|---|---|---|---|')
    for (const e of measured.envs) {
      const speed = e.monitorSpeed ? ` -b ${e.monitorSpeed}` : ''
      L.push(
        `| \`${e.name}\` | \`pio run -e ${e.name}\` | \`pio run -e ${e.name} -t upload\` | \`pio device monitor -e ${e.name}${speed}\` |`,
      )
    }
    L.push('')
    L.push('- 전체 env 빌드: `pio run`  ·  포트 확인: `pio device list`  ·  빌드 정리: `pio run -t clean`')
    for (const p of measured.configPairs) {
      L.push(`- 설정 헤더 준비: \`cp ${p.example} ${p.actual}\` 후 값 입력 (\`${p.actual}\`는 커밋하지 않는다)`)
    }
    for (const c of measured.companions) {
      const script = c.scripts.includes('start') ? 'npm run start' : c.scripts[0] ? `npm run ${c.scripts[0]}` : 'npm install 후 확인'
      L.push(`- 동반 프로세스 \`${c.dir}/\`: \`cd ${c.dir} && ${script}\``)
    }
    for (const f of measured.deployFiles) L.push(`- 배포 설정 템플릿: \`deploy/${f}\``)
    return L.join('\n')
  }
  return null
}

if (measuredKind) {
  const block = renderMeasured(measuredKind)
  if (!block) {
    console.error(`MEASURED 블록을 만들 수 없다 (domain=${domain ?? '미감지'}, kind=${measuredKind})`)
    process.exit(1)
  }
  console.log(block)
  process.exit(0)
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  const L = []
  L.push(`프로젝트: ${result.name}`)
  L.push(`경로:     ${ROOT}`)
  L.push(`도메인:   ${domain ?? '(미감지)'}${domain && !result.domainImplemented ? ' — 템플릿 미구현' : ''}`)
  if (domain === 'embedded-platformio') {
    L.push(`빌드:     platform=${measured.platform} framework=${measured.framework} default=${measured.defaultEnvs.join(',') || '(없음)'}`)
    for (const e of measured.envs) {
      L.push(`  env ${e.name}: board=${e.board} monitor=${e.monitorSpeed ?? '-'}${e.note ? ` // ${e.note}` : ''}`)
      if (e.buildSrcFilter) L.push(`      src_filter: ${e.buildSrcFilter.replace(/\s+/g, ' ')}`)
      if (e.libDeps.length) L.push(`      lib_deps: ${e.libDeps.length}개`)
    }
    L.push(`  src/:     ${measured.srcDirs.join(', ') || '(없음)'}`)
    L.push(`  include/: ${measured.includeFiles.join(', ') || '(없음)'}`)
    if (measured.configPairs.length) L.push(`  설정쌍:   ${measured.configPairs.map((p) => `${p.example} → ${p.actual}`).join(', ')}`)
    if (measured.companions.length) L.push(`  동반:     ${measured.companions.map((c) => `${c.dir}(${c.scripts.join('/') || 'scripts 없음'})`).join(', ')}`)
    if (measured.deployFiles.length) L.push(`  deploy/:  ${measured.deployFiles.join(', ')}`)
  }
  L.push(`공존:     codex=${coexistence.codexStackProfile ? 'O' : 'X'} crews=${coexistence.claudeCrews ? 'O' : 'X'} CLAUDE.md=${coexistence.claudeMd ? 'O' : 'X'} AGENTS.md=${coexistence.agentsMd ? 'O' : 'X'} 마커=${coexistence.markerBlocks}`)
  L.push(`gitignore 누락: ${gitignore.missing.length ? gitignore.missing.join(', ') : '없음'}`)
  if (notes.length) {
    L.push('※')
    for (const n of notes) L.push(`  - ${n}`)
  }
  console.log(L.join('\n'))
}

process.exit(domain && result.domainImplemented ? 0 : 2)
