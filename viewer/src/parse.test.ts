import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrace } from './parse.ts';

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
  assert.deepEqual(t.threads.map(x => x.tid), [1, 2]);
  assert.deepEqual(t.threads[0].spans, [{ name: 'main', start: 10, end: 40, depth: 0 }]);
  assert.deepEqual(t.threads[1].spans, [
    { name: 'worker', start: 20, end: 40, depth: 0 },
    { name: 'f', start: 21, end: 30, depth: 1 },
  ]);
  assert.equal(t.threads[1].maxDepth, 1);
  assert.deepEqual([t.start, t.end], [10, 40]);
});
