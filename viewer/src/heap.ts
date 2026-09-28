// heap.bin(libheapmap 기록, 포맷은 heapmap/FORMAT.md)을 블록 수명 목록으로 바꾼다.
// 블록 i는 [t0, t1) 동안 [addr, addr + size)를 차지한다. t1이 Infinity면 끝까지 해제되지 않은 누수 후보다.
// 시각은 µs로 바꿔 trace.json과 같은 단위로 맞춘다.

export interface Region {
  start: number; // 청크 기준 주소 (바이트)
  end: number;
}

export interface Heap {
  pid: number;
  count: number; // 블록 수
  addr: Float64Array; // 주소는 2^48 미만이라 double로 정확히 표현된다
  size: Float64Array;
  t0: Float64Array; // µs
  t1: Float64Array;
  tid: Uint32Array;
  byAddr: Uint32Array; // 블록 번호를 주소 순으로
  regions: Region[]; // 블록이 실제로 있는 주소 구간. 주소 공간을 이 구간들만 이어 붙여 그린다
  start: number;
  end: number;
  records: number;
  unknownFrees: number; // 후킹 전에 할당됐거나 memalign 등으로 할당된 블록의 free
}

const HEADER = 24, REC = 40;
const MALLOC = 1, FREE = 2, CALLOC = 3, REALLOC = 4;
const REGION_GAP = 64 * 1024; // 이보다 멀리 떨어진 블록은 다른 영역으로 나눈다

// glibc 64비트 청크 크기: 사용자 크기 + 헤더 8바이트를 16바이트 단위로 올림, 최소 32바이트.
// 사용자 포인터 p의 청크는 p-16에서 시작해 cs만큼 차지하므로, 메모리상 바로 다음 블록의 포인터는 p + cs다.
// ponytail: glibc 규칙 고정. 다른 할당자(jemalloc 등)면 틈이 약간 부정확해진다
export const chunk = (size: number) => Math.max(32, (size + 8 + 15) & ~15);

export function parseHeap(buf: ArrayBuffer): Heap {
  const v = new DataView(buf);
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 7));
  if (magic !== 'HEAPMAP') throw new Error('heap.bin이 아님');
  const recSize = v.getUint32(12, true);
  if (recSize !== REC) throw new Error(`레코드 크기 ${recSize} (기대 ${REC})`);
  const pid = v.getUint32(16, true);
  const n = Math.floor((buf.byteLength - HEADER) / REC);
  const u64 = (o: number) => v.getUint32(o, true) + v.getUint32(o + 4, true) * 2 ** 32;

  // 레코드는 스레드 버퍼 단위로 쓰여서 시각 순이 아니다. 시각 순으로 재생한다
  const ts = new Float64Array(n);
  for (let i = 0; i < n; i++) ts[i] = u64(HEADER + i * REC);
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => ts[a] - ts[b]);

  const addr: number[] = [], size: number[] = [], t0: number[] = [], t1: number[] = [], tid: number[] = [];
  const live = new Map<number, number>(); // 주소 → 블록 번호
  let unknownFrees = 0;
  const close = (a: number, t: number) => {
    const b = live.get(a);
    if (b === undefined) return false;
    t1[b] = t;
    live.delete(a);
    return true;
  };

  for (const i of order) {
    const o = HEADER + i * REC, t = ts[i] / 1000;
    const a = u64(o + 8), s = u64(o + 16), old = u64(o + 24), type = v.getUint8(o + 36);
    if (type === FREE) {
      if (a && !close(a, t)) unknownFrees++;
      continue;
    }
    if (type === REALLOC && old && !close(old, t)) unknownFrees++;
    if (type !== MALLOC && type !== CALLOC && type !== REALLOC) continue;
    if (!a) continue; // 할당 실패
    close(a, t); // 같은 주소가 살아 있으면(드묾) 앞의 것을 닫는다
    live.set(a, addr.length);
    addr.push(a);
    size.push(s);
    t0.push(t);
    t1.push(Infinity);
    tid.push(v.getUint32(o + 32, true));
  }

  const count = addr.length;
  const A = Float64Array.from(addr), S = Float64Array.from(size);
  const byAddr = Uint32Array.from({ length: count }, (_, i) => i).sort((x, y) => A[x] - A[y]);
  const regions: Region[] = [];
  for (const b of byAddr) {
    const s = A[b] - 16, e = s + chunk(S[b]);
    const r = regions[regions.length - 1];
    if (r && s - r.end < REGION_GAP) r.end = Math.max(r.end, e);
    else regions.push({ start: s, end: e });
  }
  return {
    pid, count, addr: A, size: S, t0: Float64Array.from(t0), t1: Float64Array.from(t1), tid: Uint32Array.from(tid),
    byAddr, regions, start: n ? ts[order[0]] / 1000 : 0, end: n ? ts[order[n - 1]] / 1000 : 0, records: n, unknownFrees,
  };
}

export const alive = (h: Heap, b: number, t: number) => h.t0[b] <= t && t < h.t1[b];

// 시각 t의 힙 상태: 살아 있는 블록 수·바이트, 누수 후보, 단편화 지수
// 단편화 지수 = 1 − (가장 큰 빈 틈 / 빈 틈 합). 빈 틈은 같은 영역 안에서 이웃한 살아 있는 블록 사이 공간이다.
// 영역 끝의 남은 공간(top chunk)은 새 할당에 그대로 쓰이므로 단편화로 치지 않는다.
export function stateAt(h: Heap, t: number) {
  let blocks = 0, bytes = 0, leaks = 0, leakBytes = 0, free = 0, largest = 0;
  let prevEnd = -1, r = 0;
  for (const b of h.byAddr) {
    if (!alive(h, b, t)) continue;
    blocks++;
    bytes += h.size[b];
    if (h.t1[b] === Infinity) {
      leaks++;
      leakBytes += h.size[b];
    }
    const s = h.addr[b];
    while (r < h.regions.length && h.regions[r].end <= s) {
      r++;
      prevEnd = -1; // 새 영역: 앞 영역과의 거리는 틈이 아니다
    }
    if (prevEnd >= 0 && s > prevEnd) {
      free += s - prevEnd;
      largest = Math.max(largest, s - prevEnd);
    }
    prevEnd = Math.max(prevEnd, s + chunk(h.size[b]));
  }
  return { blocks, bytes, leaks, leakBytes, free, frag: free ? 1 - largest / free : 0 };
}
