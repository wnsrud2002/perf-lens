// 힙 지도: 블록이 있는 주소 구간(영역)만 이어 붙여 격자에 펼친다. 칸 하나 = bpc 바이트.
// 시간 슬라이더의 시각 t에 살아 있는 블록을 칠한다. 끝까지 해제되지 않는 블록(누수 후보)은 빨강.
import { alive, chunk, stateAt, type Heap } from './heap.ts';
import { fit, fmt, showTip } from './util.ts';

const CELL = 4; // 칸 한 변(px). 3px 칠하고 1px 띄운다
// ImageData용 ABGR. 우선순위 순서: 빈 공간 < (선택 밖) 살아 있음 < (선택 밖) 누수 < 살아 있음 < 누수
// 한 칸에 블록 여러 개가 걸치면 우선순위 높은 색이 이긴다
const COLORS = [0xff382f2b, 0xff4a4f33, 0xff34355e, 0xff9fa93a, 0xff4d48e5]; // #2b2f38, #334f4a(흐린 청록), #5e3534(흐린 빨강), #3aa99f, #e5484d

const canvas = document.getElementById('heap') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const slider = document.getElementById('slider') as HTMLInputElement;
const play = document.getElementById('play') as HTMLButtonElement;
const stat = document.getElementById('hstat')!;

// 타임라인과 주고받는 상태. origin: 시각 표시 기준(트레이스 시작), onTime: t가 바뀌면 타임라인 다시 그리기
export const hv = {
  heap: null as Heap | null,
  t: NaN,
  origin: NaN,
  onTime: () => {},
  hl: null as Uint8Array | null, // 블록 → 선택한 함수 아래에서 할당됐나. null이면 선택 없음
  sel: '', // 선택 요약 (상태 줄에 붙인다)
  describe: (_b: number) => '', // 블록 → 할당 순간의 호출 경로
  onBlockClick: (_b: number) => {},
};
// origin이 NaN이면(트레이스 없음, 또는 다른 실행) heap.bin 시작을 기준으로 한다

let cols = 1, bpc = 16, regionRow: number[] = [], regionCell: number[] = [], maxChunk = 0;
let prio = new Uint8Array(0); // 칸 → 지금 칠해진 색의 우선순위
let img: ImageData | null = null, px32 = new Uint32Array(0);

export function setHeap(h: Heap) {
  hv.heap = h;
  maxChunk = 0;
  for (let b = 0; b < h.count; b++) maxChunk = Math.max(maxChunk, chunk(h.size[b]));
  slider.value = slider.max; // 처음엔 종료 시점: 누수 후보가 바로 보인다
  layout();
  setT(sliderTime());
}

// 슬라이더 끝(max)은 '종료 후'다. 그때 남은 블록이 전부 누수 후보
const sliderTime = () => {
  const h = hv.heap!;
  return +slider.value >= +slider.max ? h.end + 1 : h.start + ((h.end - h.start) * +slider.value) / +slider.max;
};

function setT(t: number) {
  hv.t = t;
  draw();
  hv.onTime();
}

// 모든 영역이 화면에 들어가는 가장 작은 칸 크기(2의 거듭제곱)를 고른다. 영역은 새 줄에서 시작한다
function layout() {
  const h = hv.heap;
  if (!h) return;
  cols = Math.max(1, Math.floor(canvas.clientWidth / CELL));
  const rows = Math.max(1, Math.floor(canvas.clientHeight / CELL));
  for (bpc = 16; ; bpc *= 2) {
    regionRow = [];
    regionCell = [];
    let r = 0, c = 0;
    for (const g of h.regions) {
      regionRow.push(r);
      regionCell.push(c);
      const n = Math.ceil((g.end - g.start) / bpc);
      r += Math.ceil(n / cols) + 1; // 영역 사이에 빈 줄 하나
      c += n;
    }
    if (r <= rows || bpc > 2 ** 40) {
      prio = new Uint8Array(c);
      break;
    }
  }
}

// 주소 → 영역 번호와 영역 안 칸 번호
function cellOf(a: number): [number, number] {
  const rs = hv.heap!.regions;
  let lo = 0, hi = rs.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (rs[m].start <= a) lo = m;
    else hi = m - 1;
  }
  return [lo, Math.floor((a - rs[lo].start) / bpc)];
}

function paint(g: number, c: number, p: number) {
  const k = regionCell[g] + c;
  if (p < prio[k]) return;
  prio[k] = p;
  const color = COLORS[p];
  const row = regionRow[g] + Math.floor(c / cols), col = c % cols, dpr = devicePixelRatio, W = img!.width;
  const x0 = Math.round(col * CELL * dpr), x1 = Math.round((col * CELL + CELL - 1) * dpr);
  const y0 = Math.round(row * CELL * dpr), y1 = Math.min(img!.height, Math.round((row * CELL + CELL - 1) * dpr));
  for (let y = y0; y < y1; y++) for (let o = y * W + x0, e = y * W + x1; o < e; o++) px32[o] = color;
}

// ponytail: 매 프레임 블록 전체를 훑는다(O(블록 수)). 48만 블록에서 슬라이더 20~30fps. 필요하면 t0 순 체크포인트로 살아 있는 블록만 찾기
export function draw() {
  fit(canvas, ctx);
  const h = hv.heap;
  if (!h || !canvas.width || !canvas.height) return; // 탭이 숨겨져 있으면 크기가 0이다. 보일 때 ResizeObserver가 다시 부른다
  if (!img || img.width !== canvas.width || img.height !== canvas.height) {
    img = ctx.createImageData(canvas.width, canvas.height);
    px32 = new Uint32Array(img.data.buffer);
  } else px32.fill(0);

  prio.fill(0);
  h.regions.forEach((g, i) => {
    const n = Math.ceil((g.end - g.start) / bpc);
    for (let c = 0; c < n; c++) paint(i, c, 0);
  });
  for (const b of h.byAddr) {
    if (!alive(h, b, hv.t)) continue;
    // 선택이 있으면 선택 밖 블록은 흐린 색(1, 2), 선택 안 블록은 원래 색(3, 4)
    const p = (h.t1[b] === Infinity ? 2 : 1) + (!hv.hl || hv.hl[b] ? 2 : 0);
    const s = h.addr[b] - 16;
    const [g, c0] = cellOf(s);
    const c1 = Math.floor((s + chunk(h.size[b]) - 1 - h.regions[g].start) / bpc);
    for (let c = c0; c <= c1; c++) paint(g, c, p);
  }
  ctx.putImageData(img, 0, 0);

  const s = stateAt(h, hv.t);
  const at = hv.t > h.end ? '종료 후' : fmt(hv.t - (isNaN(hv.origin) ? h.start : hv.origin));
  stat.textContent = `${at} · 살아 있음 ${s.blocks.toLocaleString()}개 ${kb(s.bytes)} · ` +
    `누수 후보 ${s.leaks.toLocaleString()}개 ${kb(s.leakBytes)} · 단편화 ${s.frag.toFixed(3)} (빈 틈 ${kb(s.free)}) · 칸당 ${bpc}B` + hv.sel;
}

export const kb = (n: number) => (n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + 'MB' : (n / 1024).toFixed(1) + 'KB');

slider.addEventListener('input', () => hv.heap && setT(sliderTime()));

let playing = 0;
play.addEventListener('click', () => {
  if (!hv.heap) return;
  if (playing) return stop();
  if (+slider.value >= +slider.max) slider.value = '0';
  play.textContent = '■';
  let last = performance.now();
  const step = (now: number) => {
    // 전체를 5초에 재생한다
    slider.value = String(Math.min(+slider.max, +slider.value + ((now - last) / 5000) * +slider.max));
    last = now;
    setT(sliderTime());
    if (+slider.value >= +slider.max) stop();
    else playing = requestAnimationFrame(step);
  };
  playing = requestAnimationFrame(step);
});
function stop() {
  cancelAnimationFrame(playing);
  playing = 0;
  play.textContent = '▶';
}

// 칸 위 블록 찾기: 주소 순 목록에서 칸 끝보다 앞에 시작하는 블록을 거꾸로 훑는다.
// 가장 큰 블록보다 멀리 떨어지면 더 볼 필요가 없다
function blockAt(g: number, c: number) {
  const h = hv.heap!;
  const cs = h.regions[g].start + c * bpc, ce = cs + bpc;
  let lo = 0, hi = h.count;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (h.addr[h.byAddr[m]] - 16 < ce) lo = m + 1;
    else hi = m;
  }
  for (let k = lo - 1; k >= 0; k--) {
    const b = h.byAddr[k], s = h.addr[b] - 16;
    if (s + maxChunk <= cs) break;
    if (s + chunk(h.size[b]) > cs && alive(h, b, hv.t)) return b;
  }
  return -1;
}

// 마우스 위치 → [영역, 칸]. 영역 밖(영역 사이 빈 줄 등)이면 null
function cellAt(e: MouseEvent): [number, number] | null {
  const h = hv.heap;
  if (!h) return null;
  const row = Math.floor(e.offsetY / CELL), col = Math.floor(e.offsetX / CELL);
  const g = regionRow.findLastIndex(r => r <= row);
  if (g < 0 || col >= cols) return null;
  const c = (row - regionRow[g]) * cols + col;
  return h.regions[g].start + c * bpc < h.regions[g].end ? [g, c] : null;
}

canvas.addEventListener('mousemove', e => {
  const h = hv.heap, at = cellAt(e);
  if (!h || !at) return showTip(e, null);
  const [g, c] = at;
  const b = blockAt(g, c);
  const o = isNaN(hv.origin) ? h.start : hv.origin;
  if (b < 0) return showTip(e, `빈 공간\n0x${(h.regions[g].start + c * bpc).toString(16)}`);
  const stack = hv.describe(b);
  showTip(e, `0x${h.addr[b].toString(16)}  ${h.size[b].toLocaleString()}B\n` + (stack ? stack + '\n' : '') +
    `할당 ${fmt(h.t0[b] - o)} (tid ${h.tid[b]})\n` +
    (h.t1[b] === Infinity ? '해제 안 됨 — 누수 후보' : `해제 ${fmt(h.t1[b] - o)}`));
});
canvas.addEventListener('mouseleave', e => showTip(e, null));

// 블록 클릭: 이 블록을 할당한 함수로 타임라인을 옮긴다 (main.ts가 onBlockClick을 채운다)
canvas.addEventListener('click', e => {
  const at = cellAt(e);
  const b = at ? blockAt(...at) : -1;
  if (b >= 0) hv.onBlockClick(b);
});
new ResizeObserver(() => {
  layout();
  draw();
}).observe(canvas);
