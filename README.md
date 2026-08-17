# claude-agent-crews

혼자 여러 개의 프로젝트를 오래 유지하는 사람을 위한 Claude Code 하네스.

프로젝트를 **측정해서** 스택·실행·검증 맥락을 `.claude/crews/`에 설치하고,
세션 시작 시 그 맥락이 자동으로 로드되게 만든다.

## 왜

혼자 하는 작업에는 팀 작업에서 남이 해 주던 세 가지가 없다.

| 없는 것 | 결과 | 이 하네스의 대응 |
|---|---|---|
| 검토자 | 코드를 쓴 모델이 유일한 검토자다 | 검증 주장에 `[실행 확인] / [정적 확인] / [미검증]` 라벨 강제 |
| 맥락 보관소 | 몇 주 뒤 재개하면 맥락이 0이고, 이미 버린 대안을 다시 시도한다 | 프로젝트 로컬 journal (결정 · 실패한 시도) |
| 지식 전파 | 한 사람이 여러 레포에서 같은 실수를 반복한다 | 도메인 단위 교차 전파 + 룰마다 `[해제]` 조건 |

## 설치

```bash
git clone https://github.com/Raunplaymore/claude-agent-crews.git
cd claude-agent-crews && bash install.sh
```

글로벌 스킬을 `~/.claude/skills/`에 심볼릭 링크로 연결한다. 이후 `git pull`만으로 내용이 최신화되고,
**새 스킬이 추가되면** `bash install.sh`를 다시 실행한다(재실행 안전).

## 사용

```text
/crews-setup     프로젝트 측정 → 도메인 감지 → 컨텍스트 설치 (재실행 시 drift 감지)
/crews-remove    생성물 제거 (손으로 쌓은 파일은 기본 보존)
```

생성되는 것:

```text
CLAUDE.md                             마커 블록 (진입점만)
.claude/crews/stack-profile.md        스택·경로·고위험 영역   [템플릿 소유 · gitignore]
.claude/crews/crews-routing.md        로드 순서·검증 라벨 규칙 [템플릿 소유 · gitignore]
.claude/crews/run-profile.md          실행·검증·배포·롤백      [프로젝트 소유 · 커밋]
.claude/crews/crews-config.md         커스텀 룰·토글           [프로젝트 소유 · 커밋]
```

**소유 규칙: 템플릿이 재생성할 수 있는 것만 gitignore한다.** 손으로 쌓은 것은 커밋 대상이고
제거·재설치에서 살아남는다. 하네스가 사용자 데이터를 먹으면 안 된다.

## 프로파일은 측정해서 쓴다

경로·보드명·명령을 모델이 추측하면 프로파일은 맥락이 아니라 소설이 된다.
그래서 사실 수집과 서식 생성은 스크립트가 한다.

```bash
node skills/crews-setup/scripts/probe.mjs [경로]            # 도메인 감지 + 측정
node skills/crews-setup/scripts/probe.mjs --measured=stack   # 프로파일 MEASURED 블록 렌더
node skills/crews-setup/scripts/apply-measured.mjs [경로]    # 블록 주입 (멱등)
node skills/crews-setup/scripts/drift.mjs [경로]             # 설치본 ↔ 템플릿 비교
```

`MEASURED` 블록은 drift 비교에서 제외된다 — 프로젝트마다 다른 것이 정상이기 때문이다.

## 지원 도메인

| 도메인 | 상태 |
|---|---|
| `embedded-platformio` | 사용 가능 |
| `web-next` · `web-vite-react` | 감지만 (템플릿 미구현) |

## 확장 규칙

새 도메인을 추가할 때 지키는 것 — 이걸 어기면 하네스가 관리 불가능해진다.

1. **도메인 추가는 파일 1개**로 끝나야 한다. `templates/domains/{이름}/stack-profile.md`에
   "설치 매니페스트" 표를 넣으면 설치기와 `drift.mjs`가 그 표를 읽는다. 설치 로직은 고치지 않는다.
2. **결정적인 것은 스크립트, 규범은 프롬프트, 사실은 프로파일.**
   "이 지시의 출력이 실행마다 달라지면 버그인가?" 그렇다면 프롬프트는 잘못된 도구다.
3. **프로파일은 실제 레포를 읽어서 쓴다.** 관례 추측으로 채우지 않는다.
   틀린 프로파일은 없는 프로파일보다 나쁘다.
4. **열거형 목록에는 상한을 선언한다** (`<!-- cap: N -->`).
   상한 초과는 항목 추가 신호가 아니라 **메커니즘 교체 신호**다.
   예외가 늘어난다는 건 규칙에 구멍이 있다는 뜻이 아니라 규칙이 틀렸다는 신호다.
5. **모든 룰은 `[해제]` 조건을 갖는다.** 회수 경로 없는 룰은 영원히 쌓인다.
6. **하네스 기능에 의존하는 강제는 실측 후에만.** 의존성 0 스크립트를 우선한다.
   (`tools:` allowlist를 지정하면 MCP 도구가 전량 제외되는 등, 문서에 없는 제약이 있다.)
7. **모든 장치는 폐기 조건을 함께 갖는다.** 폐기 조건이 없는 기능은 추가하지 않는다.

## 로드맵

- [x] **골격** — 설치 · 제거 · 측정 · drift · 도메인 1개
- [ ] **검증** — `verifier` 역할 + `evidence/`(append-only) + `boundaries.md` + `/verify`
- [ ] **기억** — `journal.md` + `lessons.md` + 승격/회수 스킬
- [ ] **확장** — 도메인 확대 · 멀티레포 제품 레이어 · 참조·상한 체커
