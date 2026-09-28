#!/usr/bin/env python3
"""heap.bin 읽기: 요약 통계, 종료 시점에 살아 있는 블록(누수 후보), 검증.

  python3 heapdump.py heap.bin               요약
  python3 heapdump.py heap.bin --dump 20     앞 20개 레코드 출력
  python3 heapdump.py heap.bin --check T N   test_mt T N 결과와 개수 대조 (다르면 exit 1)
"""
import collections
import struct
import sys

HEADER = struct.Struct('<8sIIII')  # magic, version, rec_size, pid, reserved
BLOCK = struct.Struct('<IIQ')      # tid, count, base_ts
RECORD = struct.Struct('<IIQ')     # dt, size, addr | type << 56
TYPES = {1: 'malloc', 2: 'free', 3: 'calloc', 4: 'realloc', 5: 'realloc_old'}
MASK = (1 << 56) - 1


def read(path):
    """레코드를 (ts, addr, size, tid, type) 목록으로. 묶음 순서대로라 시각 순은 아니다"""
    data = open(path, 'rb').read()
    magic, version, rec_size, pid, _ = HEADER.unpack_from(data)
    assert magic == b'HEAPMAP\0', f'not a heap.bin: {magic!r}'
    assert version == 2 and rec_size == RECORD.size, f'version {version}, record size {rec_size}: v2(16바이트)만 읽는다'
    recs, o = [], HEADER.size
    while o + BLOCK.size <= len(data):
        tid, count, base = BLOCK.unpack_from(data, o)
        o += BLOCK.size
        if o + count * rec_size > len(data):
            print(f'warning: 잘린 묶음 (tid {tid})', file=sys.stderr)
            break
        for dt, size, at in RECORD.iter_unpack(data[o:o + count * rec_size]):
            recs.append((base + dt, at & MASK, size, tid, at >> 56))
        o += count * rec_size
    return pid, version, recs


def replay(recs):
    """시각 순으로 재생해 살아 있는 블록을 구한다. 이상한 경우(이미 살아 있는 주소에 할당 등)도 센다."""
    live = {}
    odd = collections.Counter()
    for ts, addr, size, tid, typ in sorted(recs, key=lambda r: r[0]):  # 안정 정렬: realloc_old가 realloc보다 앞에 남는다
        if typ in (2, 5):
            if addr and live.pop(addr, None) is None:
                odd['free: 모르는 주소'] += 1  # 후킹 전에 할당했거나 memalign 등 후킹 안 한 함수로 할당한 블록
            continue
        if addr:
            if addr in live:
                odd['할당: 이미 살아 있는 주소'] += 1
            live[addr] = (size, tid, ts)
    return live, odd


def main():
    args = sys.argv[1:]
    pid, version, recs = read(args[0])
    by_type = collections.Counter(TYPES.get(r[4], r[4]) for r in recs)
    tids = collections.Counter(r[3] for r in recs)
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
            print(f'{r[0]} tid={r[3]} {TYPES.get(r[4], r[4]):11} addr={r[1]:#x} size={r[2]}')

    if '--check' in args:
        i = args.index('--check')
        want = int(args[i + 1]) * int(args[i + 2])
        marked = {}  # 표식 크기로 할당된 블록 주소 → 종류 (시각 순 재생)
        got = collections.Counter()
        for ts, addr, size, tid, typ in sorted(recs, key=lambda r: r[0]):
            if typ == 1 and 7001 <= size <= 7008:
                got['malloc'] += 1
                marked[addr] = 1
            elif typ == 3 and size == 7101:
                got['calloc'] += 1
                marked[addr] = 1
            elif typ == 5:
                got['realloc old matched'] += marked.pop(addr, 0)
            elif typ == 4 and size == 7201:
                got['realloc'] += 1
                marked[addr] = 1
            elif typ == 1 and size == 7301:
                marked[addr] = 'keep'
            elif typ == 2 and marked.get(addr) == 'keep':
                got['failed realloc kept'] += 1
                del marked[addr]
            elif typ == 2 and marked.pop(addr, 0):
                got['free'] += 1
        expect = {'malloc': want, 'calloc': want, 'realloc': want, 'realloc old matched': want, 'free': 2 * want,
                  'failed realloc kept': 1}
        ok = all(got[k] == v for k, v in expect.items()) and not marked
        for k, v in expect.items():
            print(f'  check {k:20} {got[k]:>9,} / {v:,} {"ok" if got[k] == v else "MISMATCH"}')
        print('CHECK', 'PASS' if ok else f'FAIL (unfreed marked blocks: {len(marked)})')
        sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
