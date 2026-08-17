#!/bin/bash
#
# claude-agent-crews 제거 — ~/.claude/skills/ 의 심볼릭 링크만 지운다.
# 프로젝트의 .claude/crews/ 생성물은 각 프로젝트에서 /crews-remove로 먼저 제거할 것.
#
# 사용법: bash uninstall.sh
#

set -euo pipefail

TARGET_DIR="$HOME/.claude/skills"
SKILLS=(crews-setup crews-remove)

echo "=== claude-agent-crews 제거 ==="
echo ""
echo "각 프로젝트에서 /crews-remove 를 먼저 실행했습니까?"
echo "(지금 링크를 지우면 /crews-remove 슬래시 커맨드 자체가 사라져 수동 정리가 필요해집니다)"
read -r -p "계속할까요? (y/N) " answer
case "$answer" in
  y | Y) ;;
  *)
    echo "중단했습니다."
    exit 0
    ;;
esac

removed=0
for name in "${SKILLS[@]}"; do
  path="$TARGET_DIR/$name"
  if [ -L "$path" ]; then
    rm "$path"
    echo "  링크 제거: $path"
    removed=$((removed + 1))
  elif [ -e "$path" ]; then
    echo "  건너뜀(링크 아님 — 직접 확인 필요): $path"
  fi
done

echo ""
echo "완료 — 링크 ${removed}개 제거"
