#!/usr/bin/env node
/**
 * MEASURED 블록 주입
 *
 * probe.mjs가 만든 측정 블록을 설치된 프로파일의 마커 사이에 넣는다.
 * 모델이 Edit로 직접 넣지 않는 이유: 마커 구간 치환은 결정적 작업이고,
 * 실행마다 결과가 달라지면(마커 유실·중복 삽입) drift 비교가 무너진다.
 * 재실행 안전 — 기존 블록 내용을 새 측정으로 교체한다.
 *
 * 사용법:
 *   node ~/.claude/skills/crews-setup/scripts/apply-measured.mjs [프로젝트경로]
 *
 * exit code: 0 = 주입/갱신 완료, 1 = 마커 없음 또는 측정 실패
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROBE = path.join(HERE, 'probe.mjs')
const PROJECT = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.cwd())

// 대상: {설치 파일, 측정 종류}. 파일이 없으면 건너뛴다(매니페스트에서 제외된 경우).
const TARGETS = [
  { file: '.claude/crews/stack-profile.md', kind: 'stack' },
  { file: '.claude/crews/run-profile.md', kind: 'run' },
]

const MARKER = /(<!-- MEASURED:START[^>]*-->\n)[\s\S]*?(<!-- MEASURED:END -->)/

let failed = false
for (const { file, kind } of TARGETS) {
  const full = path.join(PROJECT, file)
  if (!fs.existsSync(full)) {
    console.log(`건너뜀(파일 없음): ${file}`)
    continue
  }
  const text = fs.readFileSync(full, 'utf8')
  if (!MARKER.test(text)) {
    console.error(`❌ MEASURED 마커가 없다: ${file} — 템플릿이 손상됐거나 사용자가 마커를 지웠다`)
    failed = true
    continue
  }
  let block
  try {
    block = execFileSync('node', [PROBE, `--measured=${kind}`, PROJECT], { encoding: 'utf8' }).trimEnd()
  } catch (error) {
    console.error(`❌ 측정 실패(${kind}): ${error.message.split('\n')[0]}`)
    failed = true
    continue
  }
  const next = text.replace(MARKER, `$1${block}\n$2`)
  if (next === text) {
    console.log(`변경 없음: ${file} (${kind})`)
    continue
  }
  fs.writeFileSync(full, next)
  console.log(`갱신: ${file} (${kind}, ${block.split('\n').length}줄)`)
}

process.exit(failed ? 1 : 0)
