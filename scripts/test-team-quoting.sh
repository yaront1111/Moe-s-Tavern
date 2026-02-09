#!/bin/bash
# Test that moe-team.sh handles paths with special characters correctly.
# Uses 'background' terminal mode with a mock moe-agent.sh to verify
# the constructed command passes arguments safely.

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

cleanup() {
    if [ -n "${TEST_DIR:-}" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}
trap cleanup EXIT

assert_contains() {
    local file="$1"
    local expected="$2"
    local label="$3"
    if [ ! -f "$file" ]; then
        echo -e "${RED}FAIL${NC}: $label - output file not found: $file"
        FAIL=$((FAIL + 1))
        return
    fi
    if grep -qF -- "$expected" "$file"; then
        echo -e "${GREEN}PASS${NC}: $label"
        PASS=$((PASS + 1))
    else
        echo -e "${RED}FAIL${NC}: $label"
        echo "  Expected to find: $expected"
        echo "  File contents: $(cat "$file")"
        FAIL=$((FAIL + 1))
    fi
}

# Create temp directory with special characters in the name
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/moe test dir.XXXXXX")

# Create a mock moe-agent.sh that records its arguments
MOCK_SCRIPT_DIR="$TEST_DIR/scripts"
mkdir -p "$MOCK_SCRIPT_DIR"
cat > "$MOCK_SCRIPT_DIR/moe-agent.sh" << 'MOCK_EOF'
#!/bin/bash
# Mock agent that writes arguments to a file for verification
ARGS_FILE="${MOE_TEST_ARGS_FILE:-/tmp/moe-test-args.txt}"
printf '%s\n' "$@" > "$ARGS_FILE"
echo "MOCK_RECEIVED_ARGS: $*"
MOCK_EOF
chmod +x "$MOCK_SCRIPT_DIR/moe-agent.sh"

# Copy moe-team.sh to the mock script dir so SCRIPT_DIR points there
cp "$SCRIPT_DIR/moe-team.sh" "$MOCK_SCRIPT_DIR/moe-team.sh"
chmod +x "$MOCK_SCRIPT_DIR/moe-team.sh"

echo "=== Testing moe-team.sh argument quoting ==="
echo ""

# --- Test 1: Path with spaces ---
echo "Test 1: Path with spaces"
ARGS_FILE="$TEST_DIR/args1.txt"
LOG_FILE="/tmp/moe-worker.log"
export MOE_TEST_ARGS_FILE="$ARGS_FILE"
"$MOCK_SCRIPT_DIR/moe-team.sh" \
    --project "$TEST_DIR/my project" \
    --terminal background \
    --no-qa --no-architect \
    --delay 0 2>/dev/null || true
# Wait for background process
sleep 1
assert_contains "$ARGS_FILE" "--project" "space path: --project arg present"
assert_contains "$ARGS_FILE" "$TEST_DIR/my project" "space path: full path preserved"

# --- Test 2: Path with single quotes ---
echo "Test 2: Path with single quotes"
ARGS_FILE="$TEST_DIR/args2.txt"
export MOE_TEST_ARGS_FILE="$ARGS_FILE"
QUOTED_DIR="$TEST_DIR/it's a project"
mkdir -p "$QUOTED_DIR" 2>/dev/null || true
"$MOCK_SCRIPT_DIR/moe-team.sh" \
    --project "$QUOTED_DIR" \
    --terminal background \
    --no-qa --no-architect \
    --delay 0 2>/dev/null || true
sleep 1
assert_contains "$ARGS_FILE" "--project" "single-quote path: --project arg present"
assert_contains "$ARGS_FILE" "it's a project" "single-quote path: quote preserved"

# --- Test 3: Path with dollar sign ---
echo "Test 3: Path with dollar sign"
ARGS_FILE="$TEST_DIR/args3.txt"
export MOE_TEST_ARGS_FILE="$ARGS_FILE"
DOLLAR_DIR="$TEST_DIR/cost\$100"
mkdir -p "$DOLLAR_DIR" 2>/dev/null || true
"$MOCK_SCRIPT_DIR/moe-team.sh" \
    --project "$DOLLAR_DIR" \
    --terminal background \
    --no-qa --no-architect \
    --delay 0 2>/dev/null || true
sleep 1
assert_contains "$ARGS_FILE" "--project" "dollar path: --project arg present"

# --- Summary ---
echo ""
TOTAL=$((PASS + FAIL))
echo "=== Results: $PASS/$TOTAL passed ==="
if [ "$FAIL" -gt 0 ]; then
    echo -e "${RED}$FAIL test(s) failed${NC}"
    exit 1
else
    echo -e "${GREEN}All tests passed${NC}"
    exit 0
fi
