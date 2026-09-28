import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from './analyze.ts';

test('self/total 구분, 재귀는 total 한 번만, 같은 스택은 합산', () => {
  // main(0~100) ─ f(10~40) ─ f(15~35)   재귀
  //             └ g(50~90) ─ f(60~70)
  const { stats, flame } = analyze({
    names: ['main', 'f', 'g'],
    start: 0,
    end: 100,
    count: 5,
    threads: [{
      tid: 1,
      start: new Float64Array([0, 10, 15, 50, 60]),
      end: new Float64Array([100, 40, 35, 90, 70]),
      depth: new Uint16Array([0, 1, 2, 1, 2]),
      name: new Uint32Array([0, 1, 1, 2, 1]),
      rows: [],
    }],
  });
  const by = Object.fromEntries(stats.map(s => [s.name, s]));
  assert.deepEqual(by.main, { name: 'main', calls: 1, total: 100, self: 30 });
  assert.deepEqual(by.f, { name: 'f', calls: 3, total: 40, self: 40 }); // 30(바깥 f) + 10(g 아래 f)
  assert.deepEqual(by.g, { name: 'g', calls: 1, total: 40, self: 30 });

  assert.equal(flame.total, 100);
  const main = flame.children.get('main')!;
  assert.equal(main.children.get('f')!.total, 30);
  assert.equal(main.children.get('f')!.children.get('f')!.total, 20);
  assert.equal(main.children.get('g')!.children.get('f')!.total, 10);
});
