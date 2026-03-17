#!/bin/bash
# Run all autoweb tests. Exit 0 if all pass, 1 if any fail.
TESTS_DIR="/opt/feather/autoweb-tests"

PASS=0
FAIL=0

for test in "$TESTS_DIR"/test-*.sh; do
    [ -f "$test" ] || continue
    [ "${test%.bak}" != "$test" ] && continue
    bash "$test" > /dev/null 2>&1
    if [ $? -eq 0 ]; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
        echo "FAIL: $(basename $test)"
    fi
done

echo "$PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
