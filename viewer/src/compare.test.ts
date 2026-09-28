import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff, type Snapshot } from './compare.ts';

const snap = (stats: [string, number][], allocs: [string, number][] = []): Snapshot => ({
  label: '', duration: 0, leaks: NaN, leakBytes: NaN,
  stats: stats.map(([name, total]) => ({ name, total, self: total, calls: 1 })),
  allocs: allocs.map(([name, leakBytes]) => ({ name, allocs: 1, bytes: 1, leaks: 1, leakBytes })),
});

test('함수를 합쳐 total 변화가 큰 순서로, 한쪽에만 있는 함수도 남긴다', () => {
  const rows = diff(
    snap([['main', 100], ['slow', 80], ['gone', 5]], [['slow', 40]]),
    snap([['main', 30], ['slow', 5], ['new', 7]]), // 변화량: slow 75, main 70, new 7, gone 5
  );
  assert.deepEqual(rows.map(r => r.name), ['slow', 'main', 'new', 'gone']);
  assert.equal(rows[0].before?.total, 80);
  assert.equal(rows[0].after?.total, 5);
  assert.equal(rows[0].allocBefore?.leakBytes, 40);
  assert.equal(rows[0].allocAfter, undefined);
  assert.equal(rows[2].before, undefined);
});
