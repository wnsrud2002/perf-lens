#!/bin/sh
# libheapmap 오버헤드: 후킹 없이 vs LD_PRELOAD로 후킹, hyperfine 중앙값 비교
# 사용: ./bench.sh [라이브러리 경로=./libheapmap.so]
# 측정 전: sudo jetson_clocks (CPU 클럭 고정), 무거운 프로세스 끄기
set -e
cd "$(dirname "$0")"
LIB=$(realpath "${1:-./libheapmap.so}")
JQ=$(realpath ../targets/jq-plain/jq) # -pg 없이 -O2로 빌드한 jq (BENCH.md 참고)
OUT=${TMPDIR:-/tmp}/heapmap-bench
mkdir -p "$OUT"
make -s test_mt

run() { # 이름, 명령
    hyperfine -N --warmup 3 --runs 15 --export-json "$OUT/$1.json" \
        -n base "$2" \
        -n hook "env LD_PRELOAD=$LIB HEAPMAP_OUT=$OUT/$1.bin $2" >/dev/null
    python3 - "$OUT/$1.json" "$OUT/$1.bin" "$1" <<'EOF'
import json, os, statistics, sys
sys.path.insert(0, '.')
from heapdump import read
r = {x['command']: x['times'] for x in json.load(open(sys.argv[1]))['results']}
b, h = statistics.median(r['base']), statistics.median(r['hook'])
calls = sum(1 for x in read(sys.argv[2])[2] if x[4] != 5)  # realloc_old는 realloc 호출의 일부라 빼고 센다
print(f"{sys.argv[3]:12} base {b*1e3:7.1f} ms  hook {h*1e3:7.1f} ms  overhead {100*(h-b)/b:6.1f}%  "
      f"calls {calls:>9,}  {1e9*(h-b)/calls:6.1f} ns/call  heap.bin {os.path.getsize(sys.argv[2])/2**20:5.1f} MB")
EOF
}

run test_mt_1x "./test_mt 1 200000"
run test_mt_4x "./test_mt 4 100000"
run jq "$JQ -n [range(20000)]|map({a:.,b:(.*2|tostring)})|group_by(.a%10)|length"
