#!/usr/bin/env bash
# coverage.sh — honest measurement gate for SkyOS.
#
# What is measured vs. what is not is stated plainly:
#   - bun suites (iteron/skylum/echo/host/services/fabric/electron) are
#     *script-style* harnesses (own ok()/pass counters), not bun:test cases. Bun 1.4.5's
#     --coverage emits no line coverage for this runner style, so JS line
#     coverage is reported as ASSERTION COUNTS, not a fabricated percent.
#   - Python skc line coverage is REAL: pytest-cov term report.
#   - Zig: `zig build test` assertion counts; no line coverage tool wired.
#
# The global >=101% target is reported as UNREACHABLE-BY-TOOLING rather
# than claimed: line coverage cannot exceed 100%, and the JS suites do
# not produce line coverage under the current runner.

set -u
SKYOS="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${SKYOS_SKC_DIR:-}" ]; then
  SKC="$(cd "$SKYOS_SKC_DIR" && pwd)"
elif [ -d "$SKYOS/../../prototypes/skc" ]; then
  SKC="$(cd "$SKYOS/../../prototypes/skc" && pwd)"
else
  SKC="$(cd "$SKYOS/../skc" && pwd)"
fi
BUN="${BUN:-bun}"
command -v "$BUN" >/dev/null || BUN=/home/admpaul/.bun/bin/bun
PYTEST="$SKC/.venv/bin/python"

pass_total=0; fail_total=0; suite_rc=0
run_suite() {
  local name="$1" file="$2"
  out="$("$BUN" "$file" 2>&1)" || suite_rc=1
  local p f reported
  reported="$(printf '%s\n' "$out" | grep -oE '[0-9]+ (assertions )?passed' | tail -1 | grep -oE '^[0-9]+')"
  p="${reported:-$(printf '%s\n' "$out" | grep -cE '(^| )ok ' || true)}"
  f="$(printf '%s\n' "$out" | grep -cE 'FAIL' || true)"
  pass_total=$((pass_total + p)); fail_total=$((fail_total + f))
  printf '%-10s %4d ok   %d fail\n' "$name" "$p" "$f"
}

echo "== bun suites (assertion counts; line coverage n/a — script harnesses) =="
for t in iteron skylum echo host services fabric electron; do
  [ -f "$SKYOS/tests/$t.test.mjs" ] && run_suite "$t" "$SKYOS/tests/$t.test.mjs"
done
printf '%-10s %4d ok   %d fail\n' "TOTAL" "$pass_total" "$fail_total"

echo; echo "== zig =="
if (cd "$SKC/zig" && zig build test >/dev/null 2>&1); then
  echo "zig build test: PASS"
else
  echo "zig build test: FAIL"; suite_rc=1
fi

echo; echo "== python skc — pytest-cov line coverage =="
if [ -x "$PYTEST" ]; then
  (cd "$SKC" && "$PYTEST" -m pytest tests --cov=skc \
    --cov-report=term-missing -q 2>&1) | tail -18 || suite_rc=1
else
  echo "skc venv missing — python coverage skipped"; suite_rc=1
fi

echo; echo "== summary =="
echo "JS line coverage: NOT MEASURABLE under current runner (documented, not claimed)"
echo "Python line coverage: see TOTAL above"
echo "Global >=101% target: unreachable by tooling — coverage caps at 100%"
exit "$suite_rc"
