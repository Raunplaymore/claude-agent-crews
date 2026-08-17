---
name: crews-setup
description: |
  claude-agent-crews 컨텍스트를 현재 프로젝트에 설치한다.
  프로젝트를 측정해 도메인을 감지하고, stack-profile / run-profile / routing / config를
  매니페스트에 따라 설치하며, 재실행 시 drift를 감지한다.
  "crews 설치", "하네스 설치", "에이전트 컨텍스트 세팅" 요청 시 사용.
---

# crews-setup

**결정적인 부분은 전부 스크립트가 한다. 이 파일은 판단과 확인만 담는다.**
(측정·서식·비교를 프롬프트로 하면 실행마다 결과가 달라진다. 결과가 달라지면 버그인 작업은 스크립트가 한다.)

경로 (심볼릭 링크 설치에서도 동일):
- 측정: `~/.claude/skills/crews-setup/scripts/probe.mjs`
- drift: `~/.claude/skills/crews-setup/scripts/drift.mjs`
- 템플릿: `~/.claude/skills/crews-setup/templates/`

프로젝트 루트에서 실행한다. `node` 실행이 불가능하면 스크립트 소스를 Read해 같은 규격으로 수동 수행한다.

## 1단계: 측정

```bash
node ~/.claude/skills/crews-setup/scripts/probe.mjs --json
```

- exit 2 (`domainImplemented: false`) → **설치하지 않는다.** 감지된 도메인명(또는 미감지)을 알리고,
  템플릿이 없다는 사실과 `templates/domains/`의 현재 목록을 보여준 뒤 중단한다.
  추측으로 다른 도메인 템플릿을 갖다 쓰지 않는다 — 틀린 프로파일은 없는 프로파일보다 나쁘다.
- exit 0 → 측정 결과 요약(도메인·env 목록·공존 상태)을 사용자에게 보여준다.

## 2단계: drift 판정

```bash
node ~/.claude/skills/crews-setup/scripts/drift.mjs --domain={1단계에서 감지된 도메인}
```

`--domain`은 **최초 설치에도 넘긴다.** 없으면 매니페스트·gitignore 기대 목록을 만들 수 없어
gitignore 항목이 조용히 누락된다 (게이트 검증에서 실제로 발생한 결함).

| 상태 | 분기 |
|---|---|
| `fresh` | 최초 설치 → 3단계 확인 후 진행 (`missing`·`gitignoreMissing`은 그대로 설치 목록이 된다) |
| `unknown-domain` | GENERATED.md 손상 또는 도메인 제거 → 사유를 보여주고 재설치 확인 |
| `ok` · drift 0 · 누락 0 | `모두 최신입니다` + gitignore 누락만 처리하고 종료 (`M`: MEASURED 블록만 재측정 갱신 옵션 제시) |
| `ok` · drift 또는 누락 있음 | 목록을 보여주고 `진행할까요? (Y/N)` |

**프로젝트 소유 파일(`preserved`)은 drift가 아니다** — 사용자가 채우는 파일이므로 덮어쓰지 않는다.
템플릿 구조가 바뀌어 갱신이 필요하면 그 사실만 알리고 판단을 사용자에게 넘긴다.

## 3단계: 공존 확인 (측정에 `codexStackProfile: true`인 경우만)

`.codex/stack-profile.md`가 있으면 **같은 사실의 진실 공급원이 둘이 된다.** 진행 전에 선택을 받는다.

```text
.codex/stack-profile.md 가 이미 있습니다. 스택 사실의 출처를 하나로 정해야 합니다.

  I) 흡수 — .claude/crews/ 를 진실로 삼는다 (측정 기반이라 내용이 더 정확)
  R) 참조 — stack-profile을 만들지 않고 .codex/stack-profile.md 를 그대로 인용한다
  S) 분리 — 둘 다 유지 (drift.mjs가 수정 시각을 비교해 갱신 방향을 경고한다)

(I/R/S)
```

선택 결과를 `crews-config.md`의 "공존 상태"에 기록한다.

- `I`: codex 쪽에 남기는 포인터는 **`.codex/crews-config.md`** 에 쓴다.
  `.codex/stack-profile.md`는 codex setup이 재생성하므로 거기 쓴 표시는 사라진다 (실측으로 확인된 제약).
- `R`: 매니페스트에서 `stack-profile.md` 행을 건너뛰고, `crews-routing.md`의 로드 순서 2번을
  `.codex/stack-profile.md`로 바꿔 쓴다.
- `S`: 두 파일이 어긋나면 아무도 알려주지 않는다는 점을 사용자에게 한 번 확인시킨다.
  이후 방어는 drift 출력의 `codexDivergence` 경고뿐이다.

## 4단계: 설치

매니페스트(도메인 `stack-profile.md`의 "설치 매니페스트" 표)의 각 행을 처리한다.

1. `템플릿` 소유: `templates/{소스}` → `{대상}` 복사(덮어쓰기)
2. `프로젝트` 소유: 대상이 **없을 때만** 복사. 있으면 건드리지 않는다
3. MEASURED 블록 채우기 — **Edit로 직접 넣지 않는다.** 서식과 치환 모두 스크립트가 한다:
   ```bash
   node ~/.claude/skills/crews-setup/scripts/apply-measured.mjs
   ```
   재실행 안전하며, 프로젝트 소유 파일이 이미 있어도 이 블록만 갱신한다.
   마커가 없다는 오류가 나면 템플릿이 손상된 것이므로 해당 파일을 템플릿으로 되돌린 뒤 다시 실행한다.
4. `crews-config.md`의 "도메인" 값을 채운다 (최초 설치 시에만)

## 5단계: CLAUDE.md 마커 블록

`grep -c "CREWS-START" CLAUDE.md`로 마커 수를 센다. 0개면 하단에 추가(파일 없으면 생성),
1개면 블록 전체를 교체, 2개 이상이면 첫 START~마지막 END를 제거하고 하나만 남긴다.
**마커 블록 밖의 내용은 건드리지 않는다.**

```markdown
<!-- CREWS-START -->
## Claude Agent Crews

`.claude/crews/crews-routing.md`가 있으면 코드 변경·실행·배포 전에 Read하라.
라우팅이 나머지 컨텍스트(config · stack-profile · run-profile) 로드 순서를 정의한다.
파일이 없으면 이 섹션은 무시 — 미설치 환경에서는 정상이다.
<!-- CREWS-END -->
```

`AGENTS.md`가 있으면 위 블록 아래에 `프로젝트 규칙은 AGENTS.md도 함께 읽어라.` 한 줄을 더한다.
(Claude Code가 `AGENTS.md`를 자동 로드하는지는 실측하지 않았으므로 가정하지 않는다.)

> 블록에 로직을 넣지 않는다. 이 블록은 템플릿 파일이 아니라 이 SKILL에 하드코딩되어
> **drift 자동 감지 대상 밖**이고, 바꾸면 프로젝트마다 수동 재설치가 필요해진다.

## 6단계: .gitignore

drift 출력의 `gitignoreMissing` 항목만 추가한다(기대 목록은 매니페스트에서 유도됨 — 여기 열거하지 않는다).
`# claude-agent-crews (generated)` 주석 아래에 모은다.

**커밋 대상은 gitignore하지 않는다**: `run-profile.md`, `crews-config.md`, 그리고 이후 단계에서
생기는 `journal.md` · `lessons.md` · `evidence/` · `plans/`.
소유 규칙은 **"템플릿이 재생성할 수 있는 것만 gitignore"** 다 — 손으로 쌓은 것은 제거·재설치에서 살아남아야 한다.

## 7단계: GENERATED.md

`.claude/crews/GENERATED.md`에 아래를 기록한다. `도메인:` 줄은 drift 감지의 입력이므로 형식을 지킨다.

```markdown
# claude-agent-crews 생성 기록
설치: {날짜}
프로젝트: {이름}
도메인: {도메인}
공존: {none | codex-absorbed | codex-referenced | codex-split}

## 생성된 파일
{실제로 만든 경로 — 소유(템플릿/프로젝트) 표시}

## 제거
/crews-remove
```

## 8단계: 완료 보고

설치 파일 목록(소유 표시), 측정된 env 목록, **다음에 사람이 채워야 할 곳**을 알린다:
`run-profile.md`의 "검증 경로"·"배포 순서" 빈칸이 그것이다. 빈칸을 모델이 상상해서 채우지 않는다.

## 실패 시 행동

<!-- cap: 5 — 행이 5개를 넘으면 개별 케이스를 늘리지 말고 상위 정책으로 일반화할 것 -->

| 상황 | 보고 | 선택지 |
|---|---|---|
| 도메인 미지원/미감지 | 감지값 + 현재 템플릿 목록 | (1) 중단 (2) 가장 가까운 도메인으로 진행하되 프로파일 부정확 감수 |
| `.codex/` 공존 | 두 파일의 성격 차이 | 3단계 I/R/S |
| 프로젝트 소유 파일이 이미 있음 | 어떤 파일인지 | (1) 보존(기본) (2) 백업 후 템플릿으로 교체 |
| `node` 실행 불가 | 실패 명령 | (1) 스크립트 Read 후 수동 수행 (2) 중단 |
