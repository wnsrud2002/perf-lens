import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from './analyze.ts';

test('self/total 구분, 재귀는 total 한 번만, 같은 스택은 합산', () => {
  // main(0~100) ─ f(10~40) ─ f(15~35)   재귀
  //             └ g(50~90) ─ f(60~70)
  const sp = (name: string, start: number, end: number, depth: number) => ({ name, start, end, depth });
  const { stats, flame } = analyze({
    start: 0,
    end: 100,
    threads: [{ tid: 1, maxDepth: 2, spans: [
      sp('main', 0, 100, 0), sp('f', 10, 40, 1), sp('f', 15, 35, 2), sp('g', 50, 90, 1), sp('f', 60, 70, 2),
    ] }],
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
