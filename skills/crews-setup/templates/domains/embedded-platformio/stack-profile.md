# Stack Profile: Embedded — PlatformIO

`/crews-setup`이 생성한다. **템플릿 소유** — 재설치 시 덮어써지고 gitignore된다.
프로젝트 한정 규칙은 `.claude/crews/crews-config.md`의 "커스텀 룰"에,
도메인 전체에 적용할 규칙은 `claude-agent-crews` 레포의
`skills/crews-setup/templates/domains/embedded-platformio/stack-profile.md`에 쓴다.

<!-- MEASURED:START — scripts/probe.mjs가 platformio.ini에서 읽어 채운다. 손으로 고치지 말 것 (drift 비교 제외 구간) -->
(설치 시 채워짐)
<!-- MEASURED:END -->

## 빌드 모델

PlatformIO의 `[env:*]`는 **보드 + 소스 필터 조합**이다. 따라서 이 레포는
"하나의 프로그램"이 아니라 **여러 펌웨어를 담은 하나의 트리**일 수 있다.

- `build_src_filter`가 env마다 다르면 `src/` 하위 디렉토리가 곧 **독립 펌웨어**다.
  한 env의 코드를 고칠 때 다른 env의 빌드가 깨지지 않는지는 **각 env를 따로 빌드해야** 안다.
- `[env]` 섹션 값은 모든 env의 기본값이다. env 레벨 지정이 없으면 여기서 상속된다.
- 라이브러리는 env별 `lib_deps`로 격리된다 — 한 env에 추가한 라이브러리는 다른 env에 없다.

## 경로 규약

| 유형 | 위치 |
|------|------|
| 펌웨어 소스 | `src/{노드}/main.cpp` 및 하위 |
| 공용 헤더·설정 인터페이스 | `include/` |
| 재사용 모듈 | `lib/{모듈}/` (있는 경우) |
| 테스트 | `test/` (호스트 또는 하드웨어 보조) |
| 문서·배선도·운영 메모 | `docs/` |
| 빌드 산출물 | `.pio/` — **읽지 않는다. 진단 근거로 쓰지 않는다** |

## 주요 규칙

- **시크릿은 예시 헤더 쌍으로 관리한다.** `*.example.h`는 커밋, 실제 설정 헤더는 gitignore.
  실제 설정 헤더의 값을 산출물·로그·커밋 메시지에 인용하지 않는다.
- 핀맵과 보드별 기본값은 **한 모듈에** 모은다. 노드마다 흩어지면 배선 변경 시 반드시 누락된다.
- 캡처/전송/저장/애플리케이션 로직 사이 인터페이스를 좁게 유지한다.
- 메모리 제약 경로에서는 고정 크기 버퍼 + 명시적 에러 처리. 실패를 조용히 삼키지 않는다.
- FreeRTOS 태스크는 책임 단위로 명명하고, **프레임 버퍼 소유권**을 주석으로 남긴다.
- 로그는 시리얼 출력이 유일한 관측 창이다. 진단에 필요한 값(해상도·힙·PSRAM·재연결 횟수)을
  부팅 시 한 번 찍는 관행을 깨지 않는다.

## 고위험 영역

여기에 해당하는 변경은 Quick Plan 선행 대상이고, 검증에서 자동 HIGH다.

- 카메라 핀 배치, XCLK/PCLK 타이밍, 픽셀 포맷, 프레임 크기, 센서 초기화
- PSRAM 유무와 프레임 버퍼 개수·위치
- 비동기 요청/태스크 간 프레임 버퍼 수명
- Wi-Fi 재연결, TLS 인증서, 자격증명 저장 위치
- 워치독 리셋, 태스크 스택 크기, 힙 단편화, 전원 안정성
- OTA 업데이트와 로컬 네트워크에 노출되는 원격 제어 엔드포인트
- `platformio.ini`의 `build_src_filter`·`build_flags` — 다른 env를 조용히 깨뜨린다

## 검증의 한계 (정책)

**호스트 빌드 성공은 검증이 아니다.** 이 도메인에서 빌드가 증명하는 것은 "컴파일된다"뿐이다.
타이밍·메모리·센서 초기화·전원·무선은 실기기에서만 드러난다.

- 빌드만 돌린 결과를 "동작 확인"으로 보고하지 않는다 → `[정적 확인]` 또는 `[미검증]`이다.
- 실기기가 연결되지 않은 상태에서 `[실행 확인]`을 주장할 수 없다.
- 실기기 검증 절차는 `.claude/crews/run-profile.md`의 "검증 경로"를 인용한다.

## 초기 스캔 대상

`platformio.ini` → 해당 env의 `build_src_filter`가 가리키는 `src/` 하위 → `include/` 설정 헤더
→ `docs/` → 동반 프로세스(게이트웨이 등)의 `package.json`.

## 설치 매니페스트

`/crews-setup`과 `drift.mjs`가 이 표를 읽어 설치·비교 대상을 결정한다.
**소유**: `템플릿` = 재설치 시 덮어씀 · gitignore / `프로젝트` = 보존 · 커밋 대상.

| 대상 | 소스 | 소유 |
|---|---|---|
| `.claude/crews/stack-profile.md` | `domains/embedded-platformio/stack-profile.md` | 템플릿 |
| `.claude/crews/crews-routing.md` | `common/crews-routing.md` | 템플릿 |
| `.claude/crews/run-profile.md` | `domains/embedded-platformio/run-profile.md` | 프로젝트 |
| `.claude/crews/crews-config.md` | `common/crews-config.md` | 프로젝트 |
