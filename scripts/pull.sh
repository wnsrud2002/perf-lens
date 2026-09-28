#!/bin/sh
# 맥에서 실행: Orin Nano의 trace.json과 heap.bin을 viewer/public/으로 가져온다.
set -e
dest="$(dirname "$0")/../viewer/public"
mkdir -p "$dest"
scp "${HOST:-orinnano}:workspace/perf-lens/samples/trace.json" "${HOST:-orinnano}:workspace/perf-lens/samples/heap.bin" "$dest/"
