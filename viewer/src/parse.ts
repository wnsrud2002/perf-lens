// uftrace `dump --chrome` 출력(B/E 이벤트)을 스레드별 함수 구간으로 바꾼다.
// ts 단위는 µs이고 CLOCK_MONOTONIC 기준이다. 메인 스레드 이벤트에는 tid가 없어서 pid로 대신한다.
//
// 구간은 객체 배열 대신 열(column)마다 TypedArray 하나로 저장한다.
// 구간 100만 개 기준 GC 대상 객체가 100만 개에서 몇 개로 줄고, Worker에서 복사 없이 넘길 수 있다.

export interface Thread {
  tid: number;
  // 구간 i의 속성. i는 시작 시각 순서
  start: Float64Array; // µs
  end: Float64Array;
  depth: Uint16Array;
  name: Uint32Array; // Trace.names의 인덱스
  // rows[d] = 깊이 d인 구간 번호들. 같은 깊이 구간은 겹치지 않으므로 start와 end가 모두 오름차순이다
  rows: Uint32Array[];
}

export interface Trace {
  names: string[];
  threads: Thread[];
  start: number;
  end: number;
  count: number;
}

interface RawEvent {
  ph: string;
  ts: number;
  pid: number;
  tid?: number;
  name: string;
}

export function parseTrace(json: { traceEvents: RawEvent[] }): Trace {
  const names: string[] = [];
  const nameId = new Map<string, number>();
  type B = { start: number[]; end: number[]; depth: number[]; name: number[]; stack: number[] };
  const byTid = new Map<number, B>();
  let start = Infinity, end = -Infinity;

  for (const e of json.traceEvents) {
    if (e.ph !== 'B' && e.ph !== 'E') continue;
    const tid = e.tid ?? e.pid;
    let t = byTid.get(tid);
    if (!t) byTid.set(tid, (t = { start: [], end: [], depth: [], name: [], stack: [] }));
    if (e.ts < start) start = e.ts;
    if (e.ts > end) end = e.ts;
    let id = nameId.get(e.name);
    if (id === undefined) nameId.set(e.name, (id = names.push(e.name) - 1));

    if (e.ph === 'B') {
      t.stack.push(t.start.length);
      t.start.push(e.ts);
      t.end.push(NaN);
      t.depth.push(t.stack.length - 1);
      t.name.push(id);
    } else {
      // 짝이 안 맞는 E(예: linux:schedule 선점)는 같은 이름의 B가 스택에 있을 때만 닫는다.
      let i = t.stack.length - 1;
      while (i >= 0 && t.name[t.stack[i]] !== id) i--;
      if (i < 0) continue;
      for (const s of t.stack.splice(i)) t.end[s] = e.ts;
    }
  }

  const threads: Thread[] = [];
  for (const [tid, t] of byTid) {
    for (const s of t.stack) t.end[s] = end; // 끝나지 않은 함수는 트레이스 끝까지 늘린다
    const depth = Uint16Array.from(t.depth);
    let maxDepth = 0;
    const perDepth: number[] = [];
    for (const d of depth) {
      perDepth[d] = (perDepth[d] ?? 0) + 1;
      if (d > maxDepth) maxDepth = d;
    }
    const rows = Array.from({ length: maxDepth + 1 }, (_, d) => new Uint32Array(perDepth[d] ?? 0));
    const fill = new Uint32Array(maxDepth + 1);
    depth.forEach((d, i) => (rows[d][fill[d]++] = i));
    threads.push({ tid, start: Float64Array.from(t.start), end: Float64Array.from(t.end), depth, name: Uint32Array.from(t.name), rows });
  }
  threads.sort((a, b) => a.tid - b.tid);
  const count = threads.reduce((a, th) => a + th.start.length, 0);
  return { names, threads, start, end, count };
}

// rows[d] 안에서 col[idx[k]] >= v 인 첫 k (lo부터). col은 start나 end
export function lowerBound(idx: Uint32Array, col: Float64Array, v: number, lo = 0) {
  let hi = idx.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (col[idx[m]] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}
