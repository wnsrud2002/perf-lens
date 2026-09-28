#!/usr/bin/env python3
"""heap.bin 읽기: 요약 통계, 종료 시점에 살아 있는 블록(누수 후보), 검증.

  python3 heapdump.py heap.bin               요약
  python3 heapdump.py heap.bin --dump 20     앞 20개 레코드 출력
  python3 heapdump.py heap.bin --check T N   test_mt T N 결과와 개수 대조 (다르면 exit 1)
"""
import collections
import struct
import sys

HEADER = struct.Struct('<8sIIII')      # magic, version, rec_size, pid, reserved
RECORD = struct.Struct('<QQQQIB3x')    # ts, addr, size, old, tid, type
TYPES = {1: 'malloc', 2: 'free', 3: 'calloc', 4: 'realloc'}


def read(path):
    data = open(path, 'rb').read()
    magic, version, rec_size, pid, _ = HEADER.unpack_from(data)
    assert magic == b'HEAPMAP\0', f'not a heap.bin: {magic!r}'
    assert rec_size == RECORD.size, f'record size {rec_size} != {RECORD.size}'
    body = data[HEADER.size:]
    if len(body) % rec_size:
        print(f'warning: trailing {len(body) % rec_size} bytes', file=sys.stderr)
    recs = [RECORD.unpack_from(body, o) for o in range(0, len(body) - rec_size + 1, rec_size)]
    return pid, version, recs


def replay(recs):
    """시각 순으로 재생해 살아 있는 블록을 구한다. 이상한 경우(이미 살아 있는 주소에 할당 등)도 센다."""
    live = {}
    odd = collections.Counter()
    for ts, addr, size, old, tid, typ in sorted(recs, key=lambda r: r[0]):
        if typ == 2:
            if addr and live.pop(addr, None) is None:
                odd['free: 모르는 주소'] += 1  # 후킹 전에 할당했거나 memalign 등 후킹 안 한 함수로 할당한 블록
            continue
        if typ == 4 and old and live.pop(old, None) is None:
            odd['realloc: 모르는 원래 주소'] += 1
        if addr:
            if addr in live:
                odd['할당: 이미 살아 있는 주소'] += 1
            live[addr] = (size, tid, ts)
    return live, odd


def main():
    args = sys.argv[1:]
    pid, version, recs = read(args[0])
    by_type = collections.Counter(TYPES.get(r[5], r[5]) for r in recs)
    tids = collections.Counter(r[4] for r in recs)
    print(f'pid {pid}, version {version}, records {len(recs):,}, threads {len(tids)}')
    print('  ' + ', '.join(f'{k} {v:,}' for k, v in sorted(by_type.items())))
    if recs:
        print(f'  span {(max(r[0] for r in recs) - min(r[0] for r in recs)) / 1e6:.3f} ms')
    live, odd = replay(recs)
    print(f'  alive at exit: {len(live):,} blocks, {sum(v[0] for v in live.values()):,} bytes')
    for k, v in odd.items():
        print(f'  {k}: {v:,}')

    if '--dump' in args:
        for r in recs[: int(args[args.index('--dump') + 1])]:
            print(f'{r[0]} tid={r[4]} {TYPES.get(r[5], r[5]):8} addr={r[1]:#x} size={r[2]} old={r[3]:#x}')

    if '--check' in args:
        i = args.index('--check')
        want = int(args[i + 1]) * int(args[i + 2])
        marked = {}  # 표식 크기로 할당된 블록 주소 → 종류 (시각 순 재생)
        got = collections.Counter()
        for ts, addr, size, old, tid, typ in sorted(recs, key=lambda r: r[0]):
            if typ == 1 and 7001 <= size <= 7008:
                got['malloc'] += 1
                marked[addr] = 1
            elif typ == 3 and size == 7101:
                got['calloc'] += 1
                marked[addr] = 1
            elif typ == 4 and size == 7201:
                got['realloc'] += 1
                got['realloc old matched'] += marked.pop(old, 0)
                marked[addr] = 1
            elif typ == 2 and marked.pop(addr, 0):
                got['free'] += 1
        expect = {'malloc': want, 'calloc': want, 'realloc': want, 'realloc old matched': want, 'free': 2 * want}
        ok = all(got[k] == v for k, v in expect.items()) and not marked
        for k, v in expect.items():
            print(f'  check {k:20} {got[k]:>9,} / {v:,} {"ok" if got[k] == v else "MISMATCH"}')
        print('CHECK', 'PASS' if ok else f'FAIL (unfreed marked blocks: {len(marked)})')
        sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
