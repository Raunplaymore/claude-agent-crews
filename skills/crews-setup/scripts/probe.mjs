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

// ---------- pyproject 파싱 ----------
// Node 표준 라이브러리에 TOML 파서가 없다. 필요한 키만 좁게 읽는다
// (name / requires-python / dependencies / project.scripts). 그 밖의 문법은 다루지 않는다 —
// 여기서 읽지 못한 사실은 프로파일에 "미측정"으로 남기고 추측하지 않는다.
const parsePyproject = (text) => {
  if (!text) return null
  const out = { name: null, requiresPython: null, dependencies: [], scripts: {} }
  let section = null
  let inDeps = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (inDeps) {
      if (line.startsWith(']')) {
        inDeps = false
        continue
      }
      const dep = line.match(/^["']([^"']+)["']/)
      if (dep) out.dependencies.push(dep[1])
      continue
    }
    const sec = line.match(/^\[([^\]]+)\]$/)
    if (sec) {
      section = sec[1]
      continue
    }
    if (section === 'project') {
      const name = line.match(/^name\s*=\s*["']([^"']+)["']/)
      if (name) out.name = name[1]
      const req = line.match(/^requires-python\s*=\s*["']([^"']+)["']/)
      if (req) out.requiresPython = req[1]
      if (/^dependencies\s*=\s*\[/.test(line)) {
        inDeps = true
        // 한 줄로 끝나는 경우도 처리
        const inline = line.slice(line.indexOf('[') + 1)
        if (inline.includes(']')) {
          inDeps = false
          for (const m of inline.matchAll(/["']([^"']+)["']/g)) out.dependencies.push(m[1])
        }
      }
      continue
    }
    if (section === 'project.scripts') {
      const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/)
      if (kv) out.scripts[kv[1]] = kv[2]
    }
  }
  return out
}

// ---------- Makefile 파싱 ----------
// ML 프로젝트에서 Makefile은 사실상 조작 인터페이스다. 타깃·기본 변수·필수 변수 가드를 읽는다.
const parseMakefile = (text) => {
  if (!text) return null
  const out = { variables: {}, targets: [] }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const v = line.match(/^([A-Z][A-Z0-9_]*)\s*\?=\s*(.*)$/)
    if (v) {
      out.variables[v[1]] = v[2].trim()
      continue
    }
    const t = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (!t || line.startsWith('.PHONY')) continue
    const prereqs = t[2].trim().split(/\s+/).filter(Boolean)
    // 레시피 줄에서 필수 변수 가드(test -n "$(VAR)")를 모은다
    const required = []
    for (let j = i + 1; j < lines.length && /^\t/.test(lines[j]); j += 1) {
      for (const m of lines[j].matchAll(/test -n "\$\(([A-Z0-9_]+)\)"/g)) required.push(m[1])
    }
    out.targets.push({ name: t[1], prereqs, required: [...new Set(required)] })
  }
  return out
}

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

const pyproject = parsePyproject(read('pyproject.toml'))
const pyDeps = (pyproject?.dependencies ?? []).map((d) => d.toLowerCase())
const hasPyDep = (...names) =>
  names.some((n) => pyDeps.some((d) => d === n || d.startsWith(`${n}[`) || d.startsWith(`${n}>`) || d.startsWith(`${n}=`) || d.startsWith(`${n}<`) || d.startsWith(`${n}~`)))

let domain = null
let confidence = null
const notes = []

if (exists('platformio.ini')) {
  domain = 'embedded-platformio'
  confidence = 'certain'
} else if (pyproject && hasPyDep('ultralytics', 'torch', 'tensorflow', 'jax', 'transformers', 'scikit-learn', 'onnx')) {
  domain = 'ml-python'
  confidence = 'certain'
} else if (dep('next')) {
  domain = 'web-next'
  confidence = 'certain'
} else if (dep('vite') && (dep('react') || dep('react-dom'))) {
  domain = 'web-vite-react'
  confidence = 'certain'
}
// 템플릿이 실재하는 도메인만 설치 가능하다. 감지됐다고 설치하지 않는다 —
// 틀린 프로파일은 없는 프로파일보다 나쁘다.
const IMPLEMENTED = new Set(['embedded-platformio', 'ml-python'])

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

if (domain === 'ml-python') {
  const make = parseMakefile(read('Makefile'))
  measured.package = pyproject.name
  measured.requiresPython = pyproject.requiresPython
  measured.pinnedPython = (read('.python-version') ?? '').trim() || null
  measured.dependencies = pyproject.dependencies
  measured.entryPoints = pyproject.scripts
  measured.srcLayout = exists('src')
  measured.packages = dirs('src').filter((d) => !d.endsWith('.egg-info'))
  measured.venv = exists('.venv')
  // 조작 인터페이스: Makefile 타깃 (파이프라인 조합과 필수 변수 가드 포함)
  measured.make = make
    ? {
        variables: make.variables,
        targets: make.targets.map((t) => ({
          name: t.name,
          prereqs: t.prereqs,
          required: t.required,
        })),
      }
    : null
  measured.configs = files('configs')
  measured.scripts = files('scripts')
  measured.notebooks = files('notebooks').filter((f) => f.endsWith('.ipynb'))
  measured.docs = files('docs')
  measured.retrospectives = files('docs/retrospectives')
  // 데이터·산출물 디렉토리: 존재 여부와 gitignore 여부를 함께 본다
  //   (커밋되면 안 되는 것이 커밋 대상으로 잡혀 있으면 그 자체가 결함이다)
  const ignoredLines = new Set(
    (read('.gitignore') ?? '')
      .split('\n')
      .map((l) => l.trim().replace(/\/$/, ''))
      .filter(Boolean),
  )
  measured.dataDirs = ['data', 'artifacts', 'runs', 'samples', 'models', 'reports']
    .filter((d) => exists(d))
    .map((d) => ({ dir: d, gitignored: ignoredLines.has(d), sub: dirs(d) }))
  measured.binaryPatterns = [...ignoredLines].filter((l) => /^\*\.(pt|onnx|hef|har|engine|tflite|pth|ckpt|safetensors)$/.test(l))
  const unignored = measured.dataDirs.filter((d) => !d.gitignored).map((d) => d.dir)
  if (unignored.length) notes.push(`데이터/산출물 디렉토리가 gitignore되지 않았다: ${unignored.join(', ')}`)
  if (!make) notes.push('Makefile 없음 — 실행 명령을 run-profile에 직접 적어야 한다')
  if (measured.configs.length === 0) notes.push('configs/ 없음 — 설정 주도 파이프라인이 아닐 수 있다')
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
const renderMlPython = (kind) => {
  const m = measured
  const L = []
  const py = m.venv ? '.venv/bin/python' : 'python3'
  if (kind === 'stack') {
    L.push(`### 측정값 — \`pyproject.toml\` · \`Makefile\` (측정: ${today})`)
    L.push('')
    L.push(`- 패키지: \`${m.package ?? '-'}\` · requires-python: \`${m.requiresPython ?? '-'}\`${m.pinnedPython ? ` · 고정 버전: \`${m.pinnedPython}\`` : ''}`)
    L.push(`- 레이아웃: ${m.srcLayout ? `src 레이아웃 — \`src/${m.packages.join('`, `src/')}\`` : '평면 레이아웃'} · venv: ${m.venv ? '`.venv/`' : '없음'}`)
    if (Object.keys(m.entryPoints).length) {
      L.push(`- 진입점: ${Object.entries(m.entryPoints).map(([k, v]) => `\`${k}\` → \`${v}\``).join(', ')}`)
    }
    L.push(`- 의존성(${m.dependencies.length}): ${m.dependencies.map((d) => `\`${d}\``).join(', ') || '(없음)'}`)
    if (m.configs.length) {
      L.push('')
      L.push(`- 설정 파일 ${m.configs.length}개: ${m.configs.map((f) => `\`configs/${f}\``).join(', ')}`)
      if (m.make?.variables?.CONFIG) L.push(`  - Makefile 기본 설정: \`${m.make.variables.CONFIG}\` (\`make CONFIG=...\`로 교체)`)
    }
    if (m.dataDirs.length) {
      L.push('')
      L.push('| 디렉토리 | 하위 | gitignore |')
      L.push('|---|---|---|')
      for (const d of m.dataDirs) {
        L.push(`| \`${d.dir}/\` | ${d.sub.map((s) => `\`${s}\``).join(', ') || '-'} | ${d.gitignored ? 'O' : '**X — 확인 필요**'} |`)
      }
    }
    if (m.binaryPatterns.length) L.push(`\n- 커밋 금지 바이너리 패턴: ${m.binaryPatterns.map((p) => `\`${p}\``).join(', ')}`)
    if (m.notebooks.length) L.push(`- 노트북: ${m.notebooks.map((f) => `\`${f}\``).join(', ')}`)
    if (m.scripts.length) L.push(`- \`scripts/\` ${m.scripts.length}개 (Makefile 타깃에서 호출)`)
    if (m.docs.length) L.push(`- \`docs/\`: ${m.docs.map((f) => `\`${f}\``).join(', ')}`)
    if (m.retrospectives.length) L.push(`- \`docs/retrospectives/\` ${m.retrospectives.length}개 — 과거 판단 근거가 여기 있다`)
    return L.join('\n')
  }
  if (kind === 'run') {
    L.push(`### 명령 — 측정값에서 유도 (측정: ${today})`)
    L.push('')
    L.push(`- 인터프리터: \`${py}\`${m.venv ? '' : ' (venv 없음 — 생성 여부 확인)'}`)
    if (m.make) {
      const pipeline = m.make.targets.find((t) => t.name === 'pipeline')
      if (pipeline?.prereqs.length) {
        L.push(`- 파이프라인 순서: ${pipeline.prereqs.map((p) => `\`${p}\``).join(' → ')}  (\`make pipeline\`)`)
      }
      L.push('')
      L.push('| 타깃 | 명령 | 필수 변수 |')
      L.push('|---|---|---|')
      for (const t of m.make.targets) {
        if (t.name === 'pipeline') continue
        L.push(`| \`${t.name}\` | \`make ${t.name}\` | ${t.required.length ? t.required.map((r) => `\`${r}=\``).join(' ') : '-'} |`)
      }
      L.push('')
      L.push('> 필수 변수가 있는 타깃은 변수를 빼면 `exit 2`로 멈춘다 — 값을 추측해 넣지 말고 사용자에게 묻는다.')
      const vars = Object.entries(m.make.variables)
      if (vars.length) L.push(`\n- Makefile 기본 변수: ${vars.map(([k, v]) => `\`${k}=${v}\``).join(', ')}`)
    } else {
      L.push(`- 실행: \`${py} -m {패키지} ...\` (Makefile 없음 — 명령을 직접 채울 것)`)
    }
    return L.join('\n')
  }
  return null
}

const renderMeasured = (kind) => {
  if (domain === 'ml-python') return renderMlPython(kind)
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
  if (domain === 'ml-python') {
    L.push(`패키지:   ${measured.package} (python ${measured.requiresPython}${measured.pinnedPython ? `, 고정 ${measured.pinnedPython}` : ''}) venv=${measured.venv ? 'O' : 'X'}`)
    L.push(`  의존성:   ${measured.dependencies.length}개 — ${measured.dependencies.slice(0, 4).join(', ')}${measured.dependencies.length > 4 ? ' …' : ''}`)
    if (measured.make) {
      const pipeline = measured.make.targets.find((t) => t.name === 'pipeline')
      L.push(`  make:     타깃 ${measured.make.targets.length}개${pipeline ? ` · pipeline = ${pipeline.prereqs.join(' → ')}` : ''}`)
      const guarded = measured.make.targets.filter((t) => t.required.length)
      if (guarded.length) L.push(`  필수변수: ${guarded.map((t) => `${t.name}(${t.required.join(',')})`).join(' ')}`)
    }
    L.push(`  configs:  ${measured.configs.join(', ') || '(없음)'}`)
    L.push(`  데이터:   ${measured.dataDirs.map((d) => `${d.dir}${d.gitignored ? '' : '(!미무시)'}`).join(', ') || '(없음)'}`)
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
