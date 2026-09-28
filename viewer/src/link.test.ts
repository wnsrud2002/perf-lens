import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Heap } from './heap.ts';
import { fnAllocs, link, pathMatches, pathText } from './link.ts';
import { parseTrace } from './parse.ts';

// tid 1: main(0~100) ─ parse(10~40) ─ dup(12~14), dup(20~22)
//                   └ f(50~90) ─ f(60~70)   재귀
const ev = (ph: string, ts: number, name: string) => ({ ph, ts, pid: 1, tid: 1, name });
const trace = parseTrace({
  traceEvents: [
    ev('B', 0, 'main'), ev('B', 10, 'parse'), ev('B', 12, 'dup'), ev('E', 14, 'dup'), ev('B', 20, 'dup'), ev('E', 22, 'dup'),
    ev('E', 40, 'parse'), ev('B', 50, 'f'), ev('B', 60, 'f'), ev('E', 70, 'f'), ev('E', 90, 'f'), ev('E', 100, 'main'),
  ],
});

// 블록: [t0, t1, size, tid]
const blocks = [
  [13, 30, 10, 1], // dup 안, 해제됨
  [21, Infinity, 20, 1], // dup 안, 누수
  [30, Infinity, 5, 1], // parse 안 (dup 밖)
  [65, 80, 7, 1], // 재귀 f 안
  [-5, Infinity, 99, 1], // 트레이스 시작 전
  [13, 20, 3, 2], // 트레이스에 없는 스레드
];
const heap = {
  count: blocks.length,
  t0: Float64Array.from(blocks, b => b[0]),
  t1: Float64Array.from(blocks, b => b[1]),
  size: Float64Array.from(blocks, b => b[2]),
  tid: Uint32Array.from(blocks, b => b[3]),
} as Heap;

test('할당 순간의 호출 경로와 가장 깊은 구간', () => {
  const l = link(trace, heap);
  assert.deepEqual([0, 1, 2, 3].map(b => pathText(trace, l, l.path[b])), [
    'main → parse → dup', 'main → parse → dup', 'main → parse', 'main → f → f',
  ]);
  assert.equal(l.path[0], l.path[1]); // 같은 경로는 같은 번호
  assert.deepEqual([...l.path.slice(4)], [-1, -1]);
  const th = trace.threads[0];
  assert.deepEqual([th.start[l.span[1]], th.end[l.span[1]]], [20, 22]); // 두 번째 dup 호출
});

test('함수별 할당은 자손 포함, 재귀는 한 번', () => {
  const l = link(trace, heap);
  const by = Object.fromEntries(fnAllocs(trace, heap, l).map(f => [f.name, f]));
  assert.deepEqual(by.parse, { name: 'parse', allocs: 3, bytes: 35, leaks: 2, leakBytes: 25 });
  assert.deepEqual(by.dup, { name: 'dup', allocs: 2, bytes: 30, leaks: 1, leakBytes: 20 });
  assert.deepEqual(by.main, { name: 'main', allocs: 4, bytes: 42, leaks: 2, leakBytes: 25 });
  assert.equal(by.f.allocs, 1);
  assert.deepEqual(by['(트레이스 밖)'], { name: '(트레이스 밖)', allocs: 2, bytes: 102, leaks: 1, leakBytes: 99 });
});

test('경로 강조: 경로 위에 선택한 함수가 있으면', () => {
  const l = link(trace, heap);
  const matched = Uint8Array.from(trace.names, n => +(n === 'parse'));
  const m = pathMatches(l, matched);
  assert.deepEqual([0, 1, 2, 3].map(b => m[l.path[b]]), [1, 1, 1, 0]);
});
