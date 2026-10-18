#!/bin/sh
# Runs every test in the repository. `claude plugin test` takes every *.test.ts under the folder it is
# given, so each mod is tested from its own folder, and browser-pane from a copy without examples/.
set -e
cd "$(dirname "$0")"

node --test server/ examples/*/tab-server/

copy=$(mktemp -d)
trap 'rm -rf "$copy"' EXIT
rsync -a --exclude examples --exclude .git --exclude .claude-plugin/types ./ "$copy/"
echo "== browser-pane"
claude plugin test "$copy"

for mod in examples/*/; do
  echo "== $mod"
  claude plugin test "$mod"
done
