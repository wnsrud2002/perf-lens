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
  const stats = new Map<string, FnStat>();

  for (const th of trace.threads) {
    const stack: { depth: number; name: string; dur: number; childSum: number; node: FlameNode }[] = [];
    const pop = () => {
      const f = stack.pop()!;
      const self = f.dur - f.childSum;
      f.node.self += self;
      stats.get(f.name)!.self += self;
    };

    for (const s of th.spans) {
      while (stack.length && stack[stack.length - 1].depth >= s.depth) pop();
      const dur = s.end - s.start;
      const parent = stack[stack.length - 1];
      const pNode = parent ? parent.node : root;
      let node = pNode.children.get(s.name);
      if (!node) pNode.children.set(s.name, (node = { name: s.name, total: 0, self: 0, parent: pNode, children: new Map() }));
      node.total += dur;
      if (parent) parent.childSum += dur;
      else root.total += dur;

      let st = stats.get(s.name);
      if (!st) stats.set(s.name, (st = { name: s.name, calls: 0, total: 0, self: 0 }));
      st.calls++;
      if (!stack.some(f => f.name === s.name)) st.total += dur;

      stack.push({ depth: s.depth, name: s.name, dur, childSum: 0, node });
    }
    while (stack.length) pop();
  }
  return { stats: [...stats.values()], flame: root };
}
