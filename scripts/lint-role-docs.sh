#!/usr/bin/env bash
set -euo pipefail

MAX_LINES="${ROLE_DOC_MAX_LINES:-40}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

lint_role_docs() {
  local root_dir="$1"
  local max_lines="$2"
  local failed=0
  local role file rel lines

  for role in architect worker qa; do
    rel="docs/roles/${role}.md"
    file="${root_dir}/${rel}"
    if [[ ! -f "$file" ]]; then
      printf 'Missing role doc: %s\n' "$rel" >&2
      failed=1
      continue
    fi

    lines="$(wc -l < "$file" | tr -d '[:space:]')"
    if (( lines > max_lines )); then
      printf 'Role doc too long: %s has %s lines (max %s)\n' "$rel" "$lines" "$max_lines" >&2
      failed=1
    else
      printf 'OK: %s has %s lines (max %s)\n' "$rel" "$lines" "$max_lines"
    fi
  done

  return "$failed"
}

if [[ "${1:-}" == "--self-test" ]]; then
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT
  mkdir -p "$tmp_dir/docs/roles"
  cp "$DEFAULT_ROOT"/docs/roles/{architect,worker,qa}.md "$tmp_dir/docs/roles/"

  lint_role_docs "$tmp_dir" "$MAX_LINES" >/dev/null
  for _ in $(seq 1 "$((MAX_LINES + 1))"); do
    printf 'padding\n' >> "$tmp_dir/docs/roles/architect.md"
  done

  if lint_role_docs "$tmp_dir" "$MAX_LINES" >/dev/null 2>&1; then
    printf 'Self-test failed: padded architect.md unexpectedly passed\n' >&2
    exit 1
  fi
  printf 'Self-test passed: valid docs pass and padded docs fail\n'
  exit 0
fi

lint_role_docs "${ROLE_DOC_ROOT:-$DEFAULT_ROOT}" "$MAX_LINES"
