// 함수 구간에서 두 가지를 뽑는다.
//   stats: 함수 이름별 호출 수, total(자식 포함), self(자식 제외) 시간
//   flame: 같은 호출 스택끼리 합산한 트리 (플레임 그래프용)
import type { Trace } from './parse.ts';

export interface FnStat {
  name: string;
  calls: number;
  total: number; // µs. 재귀 호출은 바깥쪽 한 번만 센다
  self: number;
}

export interface FlameNode {
  name: string;
  total: number;
  self: number;
  parent: FlameNode | null;
  children: Map<string, FlameNode>;
}

export function analyze(trace: Trace): { stats: FnStat[]; flame: FlameNode } {
  const root: FlameNode = { name: 'all', total: 0, self: 0, parent: null, children: new Map() };
  const n = trace.names.length;
  const calls = new Float64Array(n), total = new Float64Array(n), self = new Float64Array(n);
  const onStack = new Uint32Array(n); // 이름별로 지금 스택에 몇 개 있는지 (재귀 판정)

  for (const th of trace.threads) {
    const stack: { i: number; dur: number; childSum: number; node: FlameNode }[] = [];
    const pop = () => {
      const f = stack.pop()!;
      const s = f.dur - f.childSum;
      f.node.self += s;
      self[th.name[f.i]] += s;
      onStack[th.name[f.i]]--;
    };

    for (let i = 0; i < th.start.length; i++) {
      while (stack.length && th.depth[stack[stack.length - 1].i] >= th.depth[i]) pop();
      const dur = th.end[i] - th.start[i];
      const id = th.name[i], name = trace.names[id];
      const parent = stack[stack.length - 1];
      const pNode = parent ? parent.node : root;
      let node = pNode.children.get(name);
      if (!node) pNode.children.set(name, (node = { name, total: 0, self: 0, parent: pNode, children: new Map() }));
      node.total += dur;
      if (parent) parent.childSum += dur;
      else root.total += dur;

      calls[id]++;
      if (!onStack[id]++) total[id] += dur;
      stack.push({ i, dur, childSum: 0, node });
    }
    while (stack.length) pop();
  }
  const stats = trace.names.map((name, id) => ({ name, calls: calls[id], total: total[id], self: self[id] }));
  return { stats, flame: root };
}
