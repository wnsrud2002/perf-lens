// 두 로그 연결: 할당 블록마다 "할당 순간 그 스레드에서 실행 중이던 함수들"을 찾는다.
// 두 로그는 같은 CLOCK_MONOTONIC(µs)과 같은 tid를 쓴다.
//
// 블록마다 호출 경로(main → worker → parse_request → dup_token)를 번호 하나로 저장한다.
// 경로 수는 블록 수보다 훨씬 적어서, "이 함수 아래에서 할당됐나"를 경로 단위로 한 번만 계산하면 된다.
import type { Heap } from './heap.ts';
import { lowerBound, type Trace } from './parse.ts';

export interface Link {
  path: Int32Array; // 블록 → 경로 번호. -1이면 트레이스 밖(메인 전, 기록 안 된 스레드 등)
  thread: Int32Array; // 블록 → 할당한 가장 깊은 구간의 스레드 번호(trace.threads 인덱스)
  span: Int32Array; // 블록 → 그 구간 번호. -1이면 트레이스 밖
  pathParent: number[]; // 경로 → 부모 경로 (-1이면 뿌리). 부모가 항상 먼저 만들어진다
  pathName: number[]; // 경로 → 마지막 함수의 이름 id
}

export function link(trace: Trace, heap: Heap): Link {
  const threadOf = new Map(trace.threads.map((th, i) => [th.tid, i]));
  const pathParent: number[] = [], pathName: number[] = [];
  const intern = new Map<number, number>(); // (부모+1) * 이름수 + 이름 → 경로
  const N = trace.names.length;
  const path = new Int32Array(heap.count).fill(-1);
  const thread = new Int32Array(heap.count).fill(-1);
  const span = new Int32Array(heap.count).fill(-1);

  for (let b = 0; b < heap.count; b++) {
    const n = threadOf.get(heap.tid[b]);
    if (n === undefined) continue;
    const th = trace.threads[n], t = heap.t0[b];
    let p = -1;
    // 깊이 0부터 내려가며 t를 품은 구간을 찾는다. 어떤 깊이에서 없으면 그보다 깊은 곳에도 없다
    for (const idx of th.rows) {
      const k = lowerBound(idx, th.end, t);
      if (k >= idx.length || th.start[idx[k]] > t) break;
      const i = idx[k], key = (p + 1) * N + th.name[i];
      let q = intern.get(key);
      if (q === undefined) {
        intern.set(key, (q = pathParent.length));
        pathParent.push(p);
        pathName.push(th.name[i]);
      }
      p = q;
      span[b] = i;
    }
    if (p < 0) continue;
    path[b] = p;
    thread[b] = n;
  }
  return { path, thread, span, pathParent, pathName };
}

// 경로마다 "검색어와 맞는 함수가 경로 위 어딘가에 있나". 부모가 먼저 오므로 한 번 훑으면 된다
export function pathMatches(l: Link, matched: Uint8Array) {
  const m = new Uint8Array(l.pathParent.length);
  for (let p = 0; p < m.length; p++) m[p] = matched[l.pathName[p]] || (l.pathParent[p] >= 0 ? m[l.pathParent[p]] : 0);
  return m;
}

export interface FnAlloc {
  name: string; // 트레이스 밖이면 '(트레이스 밖)'
  allocs: number;
  bytes: number;
  leaks: number; // 끝까지 해제되지 않은 블록
  leakBytes: number;
}

// 함수별 할당: 그 함수가 실행 중일 때(자손 함수 포함) 일어난 할당. 재귀는 한 번만 센다
export function fnAllocs(trace: Trace, heap: Heap, l: Link): FnAlloc[] {
  const P = l.pathParent.length;
  const pa = new Float64Array(P), pb = new Float64Array(P), pl = new Float64Array(P), plb = new Float64Array(P);
  const out = { name: '(트레이스 밖)', allocs: 0, bytes: 0, leaks: 0, leakBytes: 0 };
  for (let b = 0; b < heap.count; b++) {
    const leak = heap.t1[b] === Infinity, s = heap.size[b], p = l.path[b];
    if (p < 0) {
      out.allocs++;
      out.bytes += s;
      if (leak) (out.leaks++, (out.leakBytes += s));
      continue;
    }
    pa[p]++;
    pb[p] += s;
    if (leak) (pl[p]++, (plb[p] += s));
  }
  const by = new Map<number, FnAlloc>();
  for (let p = 0; p < P; p++) {
    if (!pa[p]) continue;
    const seen = new Set<number>();
    for (let q = p; q >= 0; q = l.pathParent[q]) {
      const id = l.pathName[q];
      if (seen.has(id)) continue;
      seen.add(id);
      let f = by.get(id);
      if (!f) by.set(id, (f = { name: trace.names[id], allocs: 0, bytes: 0, leaks: 0, leakBytes: 0 }));
      f.allocs += pa[p];
      f.bytes += pb[p];
      f.leaks += pl[p];
      f.leakBytes += plb[p];
    }
  }
  const rows = [...by.values()];
  if (out.allocs) rows.push(out);
  return rows;
}

// 경로를 "main → worker → dup_token" 글자로
export function pathText(trace: Trace, l: Link, p: number) {
  const names: string[] = [];
  for (let q = p; q >= 0; q = l.pathParent[q]) names.unshift(trace.names[l.pathName[q]]);
  return names.join(' → ');
}
