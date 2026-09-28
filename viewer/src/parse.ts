// uftrace `dump --chrome` 출력(B/E 이벤트)을 스레드별 함수 구간으로 바꾼다.
// ts 단위는 µs이고 CLOCK_MONOTONIC 기준이다. 메인 스레드 이벤트에는 tid가 없어서 pid로 대신한다.

export interface Span {
  name: string;
  start: number; // µs
  end: number;
  depth: number;
}

export interface Thread {
  tid: number;
  spans: Span[]; // start 오름차순
  maxDepth: number;
}

export interface Trace {
  threads: Thread[];
  start: number;
  end: number;
}

interface RawEvent {
  ph: string;
  ts: number;
  pid: number;
  tid?: number;
  name: string;
}

export function parseTrace(json: { traceEvents: RawEvent[] }): Trace {
  const byTid = new Map<number, { spans: Span[]; stack: Span[]; maxDepth: number }>();
  let start = Infinity, end = -Infinity;

  for (const e of json.traceEvents) {
    if (e.ph !== 'B' && e.ph !== 'E') continue;
    const tid = e.tid ?? e.pid;
    let t = byTid.get(tid);
    if (!t) byTid.set(tid, (t = { spans: [], stack: [], maxDepth: 0 }));
    if (e.ts < start) start = e.ts;
    if (e.ts > end) end = e.ts;

    if (e.ph === 'B') {
      const s: Span = { name: e.name, start: e.ts, end: NaN, depth: t.stack.length };
      t.stack.push(s);
      t.spans.push(s);
      if (s.depth > t.maxDepth) t.maxDepth = s.depth;
    } else {
      // 짝이 안 맞는 E(예: linux:schedule 선점)는 같은 이름의 B가 스택에 있을 때만 닫는다.
      const i = t.stack.map(s => s.name).lastIndexOf(e.name);
      if (i < 0) continue;
      for (const s of t.stack.splice(i)) s.end = e.ts;
    }
  }

  const threads: Thread[] = [];
  for (const [tid, t] of byTid) {
    for (const s of t.stack) s.end = end; // 끝나지 않은 함수는 트레이스 끝까지 늘린다
    threads.push({ tid, spans: t.spans, maxDepth: t.maxDepth });
  }
  threads.sort((a, b) => a.tid - b.tid);
  return { threads, start, end };
}
