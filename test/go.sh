#!/bin/sh
# usage: go.sh <response file> <solution|starter|file> -> prints the reported verdict
D=$(dirname "$0"); S=/tmp/claude-0/-home-claude/244248e3-708f-5f4f-89f2-b1345191c137/scratchpad
P=$((20000 + $$ % 20000)); export OUT=$S/out.$$.json; rm -f $OUT
node $D/mock.mjs "$1" "$2" $P & M=$!; sleep 0.7
SITE_URL=http://127.0.0.1:$P GRADER_SECRET=$(printf 's%.0s' $(seq 32)) JOB_ID=00000000-0000-0000-0000-000000000009 node $D/../run.mjs 2>&1 | tail -5
kill $M 2>/dev/null; cat $OUT 2>/dev/null; echo; rm -f $OUT
