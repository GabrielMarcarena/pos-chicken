#!/bin/bash
# usage: t12.sh [test files...]  — runs the rev12 tests with Ubuntu node; prints a compact summary
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin"
export TZ=UTC
cd "$HOME/POS device/chicken-pos-trial-rev12" || exit 1
mkdir -p /tmp/cpos-check
for f in src/*.js src/services/*.js shared/*.js server.js scripts/*.js public/js/*.js public/js/views/*.js; do node --check "$f" 2>&1 | head -5; done
files="${@:-tests/unit.test.js tests/api.test.js tests/clear.test.js tests/inventory.test.js tests/revision10.test.js tests/revision11.test.js tests/revision12.test.js}"
node --disable-warning=ExperimentalWarning --test --test-reporter=spec $files > /tmp/cpos-check/test-out.txt 2>&1
echo "exit $?"
grep -E "^ℹ (tests|pass|fail)" /tmp/cpos-check/test-out.txt
grep -E "^✖ " /tmp/cpos-check/test-out.txt | sort -u | head -80
