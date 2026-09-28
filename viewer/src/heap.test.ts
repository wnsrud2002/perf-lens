import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, parseHeap, stateAt } from './heap.ts';

// heap.bin을 직접 만든다: [ts(ns), type, addr, size, old, tid]
function bin(recs: number[][]) {
  const buf = new ArrayBuffer(24 + recs.length * 40), v = new DataView(buf);
  new Uint8Array(buf).set(new TextEncoder().encode('HEAPMAP\0'));
  v.setUint32(8, 1, true);
  v.setUint32(12, 40, true);
  v.setUint32(16, 42, true);
  recs.forEach(([ts, type, addr, size, old, tid], i) => {
    const o = 24 + i * 40;
    v.setBigUint64(o, BigInt(ts), true);
    v.setBigUint64(o + 8, BigInt(addr), true);
    v.setBigUint64(o + 16, BigInt(size), true);
    v.setBigUint64(o + 24, BigInt(old), true);
    v.setUint32(o + 32, tid, true);
    v.setUint8(o + 36, type);
  });
  return buf;
}

const A = 0xaaaa00000010; // 큰 주소도 정확해야 한다

test('chunk: glibc 청크 크기', () => {
  assert.deepEqual([0, 24, 25, 100].map(chunk), [32, 32, 48, 112]);
});

test('재생: 순서 섞인 레코드, free, realloc, 모르는 free, 누수, 영역', () => {
  const h = parseHeap(bin([
    [3000, 2, A, 0, 0, 1], // free A (시각 순으로는 세 번째)
    [1000, 1, A, 24, 0, 1], // malloc A 24B
    [2000, 3, A + 32, 100, 0, 2], // calloc 바로 옆 블록
    [4000, 4, A + 1000, 200, A + 32, 2], // realloc: A+32 해제, A+1000 할당
    [5000, 2, 0x1234, 0, 0, 1], // 모르는 주소
    [6000, 1, A + 10_000_000, 50, 0, 1], // 멀리 떨어진 블록 → 새 영역, 누수
  ]));
  assert.equal(h.pid, 42);
  assert.equal(h.records, 6);
  assert.equal(h.count, 4);
  assert.deepEqual([...h.addr], [A, A + 32, A + 1000, A + 10_000_000]);
  assert.deepEqual([...h.t0], [1, 2, 4, 6]);
  assert.deepEqual([...h.t1], [3, 4, Infinity, Infinity]);
  assert.equal(h.unknownFrees, 1);
  assert.deepEqual([h.start, h.end], [1, 6]);
  assert.equal(h.regions.length, 2);

  const s = stateAt(h, 2.5); // A(24B)와 A+32(100B)가 붙어 있다: 틈 없음
  assert.deepEqual([s.blocks, s.bytes, s.free, s.frag], [2, 124, 0, 0]);
  const e = stateAt(h, 7);
  assert.deepEqual([e.blocks, e.leaks, e.leakBytes], [2, 2, 250]);
});

test('단편화 지수 = 1 - 가장 큰 틈 / 틈 합', () => {
  // 32B 청크 블록 4개: 0, 64, 96, 192 → 틈 32(32~64), 64(128~192). 합 96, 최대 64
  const h = parseHeap(bin([0, 64, 96, 192].map((d, i) => [i + 1, 1, A + d, 16, 0, 1])));
  const s = stateAt(h, 10);
  assert.equal(s.free, 96);
  assert.ok(Math.abs(s.frag - (1 - 64 / 96)) < 1e-9);
});
