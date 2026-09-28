import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lowerBound, parseTrace } from './parse.ts';

test('B/E 짝 맞추기, tid 없는 메인 스레드, 짝 없는 E, 안 닫힌 B', () => {
  const ev = (ph: string, ts: number, name: string, tid?: number) => ({ ph, ts, pid: 1, tid, name });
  const t = parseTrace({
    traceEvents: [
      { ph: 'M', ts: 0, pid: 1, name: 'process_name' },
      ev('B', 10, 'main'),
      ev('B', 20, 'worker', 2),
      ev('B', 21, 'f', 2),
      ev('E', 25, 'stray', 2),
      ev('E', 30, 'f', 2),
      ev('E', 40, 'worker', 2),
    ],
  });
  const spans = (i: number) => {
    const th = t.threads[i];
    return [...th.start].map((s, k) => [t.names[th.name[k]], s, th.end[k], th.depth[k]]);
  };
  assert.deepEqual(t.threads.map(x => x.tid), [1, 2]);
  assert.deepEqual(spans(0), [['main', 10, 40, 0]]);
  assert.deepEqual(spans(1), [['worker', 20, 40, 0], ['f', 21, 30, 1]]);
  assert.deepEqual(t.threads[1].rows.map(r => [...r]), [[0], [1]]);
  assert.deepEqual([t.start, t.end, t.count], [10, 40, 3]);
});

test('lowerBound', () => {
  const col = new Float64Array([5, 10, 20, 30]);
  const idx = new Uint32Array([0, 1, 2, 3]);
  assert.equal(lowerBound(idx, col, 0), 0);
  assert.equal(lowerBound(idx, col, 10), 1);
  assert.equal(lowerBound(idx, col, 11), 2);
  assert.equal(lowerBound(idx, col, 99), 4);
  assert.equal(lowerBound(idx, col, 0, 3), 3);
});
