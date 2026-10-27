#!/bin/bash
# Build the repository one TypeScript project at a time.
#
# A single `tsc -b <aggregate references>` keeps every project in one process.
# On a memory-constrained host that peak exceeds the machine and the OOM killer
# terminates it. Compiling project by project keeps each process around 250 MB.
set -u
cd "$(dirname "$0")/.."
TSC=./node_modules/.bin/tsc

build_list() {
  local cfg="$1" out="$2"
  node --input-type=module -e "
import ts from 'typescript'
const r = ts.readConfigFile('$cfg', ts.sys.readFile)
console.log((r.config.references ?? []).map((x) => x.path).join('\n'))
" > "$out"
  local total count=0 fail=0
  total=$(wc -l < "$out")
  echo "=== $cfg : $total projects ==="
  while IFS= read -r p; do
    count=$((count + 1))
    if ! "$TSC" -b "$p" >/tmp/tsc-one.log 2>&1; then
      fail=$((fail + 1))
      echo "FAIL $p"
      tail -n 2 /tmp/tsc-one.log
    fi
  done < "$out"
  echo "=== $cfg done: $count projects, fail=$fail ==="
}

build_list tsconfig.host.json /tmp/host-refs.txt
build_list tsconfig.client.json /tmp/client-refs.txt
echo "ALL TSC DONE"
