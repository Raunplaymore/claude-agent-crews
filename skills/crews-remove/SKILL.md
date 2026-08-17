---
name: crews-remove
description: |
  claude-agent-crews가 설치한 프로젝트 생성물을 제거한다.
  .claude/crews/의 템플릿 소유 파일, CLAUDE.md 마커 블록, .gitignore 항목을 정리하고
  손으로 쌓은 파일(journal · lessons · evidence · plans · run-profile · config)은 보존 여부를 묻는다.
  "crews 제거", "하네스 삭제" 요청 시 사용.
---

# crews-remove

**손으로 쌓은 것을 조용히 지우지 않는다.** 이 스킬의 유일한 위험은 재생성 불가능한 데이터를
"생성물"로 묶어 함께 삭제하는 것이다. 하네스가 사용자 데이터를 먹는 순간 신뢰를 잃는다.

## 1단계: 현황 파악

`.claude/crews/GENERATED.md`를 Read한다. 없으면 `.claude/crews/`를 Glob으로 훑어 현황을 만든다.
파일을 두 부류로 나눠 보여준다.

| 부류 | 파일 | 처리 |
|---|---|---|
| **재생성 가능** (템플릿 소유) | `stack-profile.md` · `crews-routing.md` · `GENERATED.md` | 삭제 |
| **재생성 불가** (손으로 쌓음) | `run-profile.md` · `crews-config.md` · `journal.md` · `lessons.md` · `evidence/` · `plans/` | **기본 보존** |

## 2단계: 확인

```text
제거 대상 (재생성 가능):
  {목록}

보존 대상 (손으로 쌓은 것 — 다시 만들 수 없음):
  {목록, 각 파일 크기/항목 수 표시}

  K) 보존 — 위 파일들을 남긴다 (권장)
  D) 전체 삭제 — 보존 대상까지 삭제한다 (되돌릴 수 없음)
  N) 취소

(K/D/N)
```

`D`를 선택하면 무엇이 영구히 사라지는지(예: 결정 기록 N건, 실행 증거 N건) 다시 한 번 확인받는다.
`evidence/`는 append-only 기록이라 특히 되돌릴 수 없다.

## 3단계: 제거

1. 선택된 파일 삭제. 남는 파일이 없으면 `.claude/crews/` 디렉토리도 제거
2. `CLAUDE.md`의 `<!-- CREWS-START -->` ~ `<!-- CREWS-END -->` 블록 제거 (마커 포함).
   **블록 밖은 건드리지 않는다.** 블록 제거 후 파일이 비면 파일을 지운다
3. `.gitignore`의 `# claude-agent-crews (generated)` 주석과 그 아래 crews 항목 제거.
   보존한 파일에 해당하는 항목은 애초에 gitignore 대상이 아니므로 지울 것이 없다

## 4단계: 보고

삭제한 것, 보존한 것, 그리고 재설치 방법(`/crews-setup`)을 알린다.
보존한 파일이 있으면 **재설치 시 그대로 이어서 쓰인다**는 점을 명시한다.

## 실패 시 행동

<!-- cap: 5 — 행이 5개를 넘으면 상위 정책으로 일반화할 것 -->

| 상황 | 보고 | 선택지 |
|---|---|---|
| GENERATED.md 없음 | 파일시스템에서 유도한 현황 | (1) 유도 목록으로 진행 (2) 중단 |
| 마커 블록이 2개 이상 | 발견 위치 | (1) 전부 제거 (2) 중단 후 수동 확인 |
| `.claude/crews/` 밖에 crews 파일이 있음 | 경로 | (1) 목록만 보고 (2) 사용자 확인 후 개별 제거 |
