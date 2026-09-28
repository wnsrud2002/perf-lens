// 읽기와 파싱을 메인 스레드 밖에서 한다.
//   trace: 읽기 → JSON.parse → 구간 변환 → 분석
//   heap:  읽기 → 시각 순 재생 → 블록 수명 목록
// 결과의 TypedArray 버퍼는 복사하지 않고 소유권만 넘긴다(transfer).
import { analyze } from './analyze.ts';
import { parseHeap } from './heap.ts';
import { parseTrace } from './parse.ts';

self.onmessage = async (e: MessageEvent<{ kind: 'trace' | 'heap'; src: File | string }>) => {
  const { kind, src } = e.data;
  let t = performance.now();
  const times: Record<string, number> = {};
  const lap = (k: string) => {
    const now = performance.now();
    times[k] = now - t;
    t = now;
  };

  let body: Blob | Response = src as File;
  if (typeof src === 'string') {
    body = await fetch(src);
    if (!body.ok) return postMessage(null);
  }

  if (kind === 'heap') {
    const buf = await body.arrayBuffer();
    lap('읽기');
    try {
      const heap = parseHeap(buf);
      lap('재생');
      const { addr, size, t0, t1, tid, byAddr } = heap;
      return postMessage({ heap, times }, { transfer: [addr, size, t0, t1, tid, byAddr].map(a => a.buffer) });
    } catch (err) {
      return postMessage({ error: String(err) });
    }
  }

  const text = await body.text();
  lap('읽기');
  const json = JSON.parse(text);
  lap('JSON');
  const trace = parseTrace(json);
  lap('변환');
  const { stats, flame } = analyze(trace);
  lap('분석');

  const buffers = trace.threads.flatMap(th => [th.start, th.end, th.depth, th.name, ...th.rows].map(a => a.buffer));
  postMessage({ trace, stats, flame, times }, { transfer: buffers });
};
