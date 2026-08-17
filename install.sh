#!/bin/bash
#
# claude-agent-crews 설치
# 이 레포의 글로벌 스킬을 ~/.claude/skills/ 에 심볼릭 링크로 연결한다.
# 링크 방식이므로 `git pull`만으로 스킬/템플릿 내용이 최신화된다.
# 단, 이후 추가된 새 스킬의 링크를 만들려면 이 스크립트를 다시 실행해야 한다 (재실행 안전).
#
# 사용법: bash install.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$HOME/.claude/skills"

# 글로벌 스킬 목록 — 여기 한 곳만 고치면 링크/안내에 모두 반영된다
# 상한 7 — 초과하면 스킬을 추가하지 말고 통합할 것 (목록 길이는 설계 실패 계측기다)
SKILLS=(crews-setup crews-remove)

echo "=== claude-agent-crews 설치 ==="
echo ""

mkdir -p "$TARGET_DIR"

# 구버전/수동 복사본 감지 — 링크가 아닌 실체가 있으면 덮어쓰지 않고 멈춘다
for name in "${SKILLS[@]}"; do
  path="$TARGET_DIR/$name"
  if [ -e "$path" ] && [ ! -L "$path" ]; then
    echo "⚠️  링크가 아닌 실제 디렉토리/파일이 있습니다: $path"
    echo "    직접 확인 후 옮기거나 삭제하고 다시 실행하세요. 설치를 중단합니다."
    exit 1
  fi
done

for name in "${SKILLS[@]}"; do
  if [ ! -d "$SCRIPT_DIR/skills/$name" ]; then
    echo "⚠️  스킬 디렉토리가 없습니다: skills/$name — SKILLS 배열과 파일시스템이 어긋났습니다."
    exit 1
  fi
  ln -sfn "$SCRIPT_DIR/skills/$name" "$TARGET_DIR/$name"
done

echo "설치 완료 — 링크 ${#SKILLS[@]}개"
for name in "${SKILLS[@]}"; do
  printf "  %-32s ->  %s\n" "$TARGET_DIR/$name" "$SCRIPT_DIR/skills/$name"
done
echo ""
echo "사용법:"
echo "  1. 대상 프로젝트에서 Claude Code 실행"
echo "  2. /crews-setup   → 프로젝트 측정 후 컨텍스트 설치"
echo "  3. /crews-remove  → 생성물 제거"
echo ""
echo "갱신: git pull && bash install.sh"
echo "주의: 이 디렉토리($SCRIPT_DIR)를 옮기거나 삭제하면 링크가 깨집니다."
echo ""
