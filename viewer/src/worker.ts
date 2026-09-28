// 읽기 → JSON.parse → 구간 변환 → 분석을 메인 스레드 밖에서 한다.
// 결과의 TypedArray 버퍼는 복사하지 않고 소유권만 넘긴다(transfer).
import { analyze } from './analyze.ts';
import { parseTrace } from './parse.ts';

self.onmessage = async (e: MessageEvent<File | string>) => {
  const src = e.data;
  let t = performance.now();
  const times: Record<string, number> = {};
  const lap = (k: string) => {
    const now = performance.now();
    times[k] = now - t;
    t = now;
  };

  let text: string;
  if (typeof src === 'string') {
    const r = await fetch(src);
    if (!r.ok) return postMessage(null);
    text = await r.text();
  } else text = await src.text();
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
