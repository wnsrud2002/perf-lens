import type { FlameNode, FnStat } from './analyze.ts';
import { drawFlame, setFlame } from './flame.ts';
import type { Heap } from './heap.ts';
import { draw as drawHeap, hv, kb, setHeap } from './heapview.ts';
import { fnAllocs, link, pathMatches, pathText, type FnAlloc, type Link } from './link.ts';
import { lowerBound, type Trace } from './parse.ts';
import { color, fit, fmt, label, matches, search, setSearch, showTip } from './util.ts';

const ROW = 16, LANE_HEAD = 18, AXIS = 20;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const info = document.getElementById('info')!;
const q = document.getElementById('q') as HTMLInputElement;
const qInfo = document.getElementById('qinfo')!;
const table = document.getElementById('top')!;

let trace: Trace | null = null;
let laneTop: number[] = [];
let t0 = 0, t1 = 1; // 화면에 보이는 시간 범위(µs)
let dirty = true;
let stats: FnStat[] = [];
let sortKey: 'self' | 'total' = 'self';
let colors: string[] = []; // 이름 id → 색
let matched = new Uint8Array(0); // 이름 id → 검색어 일치 여부
let hits: [number, number][] = []; // 검색어와 일치하는 구간 [start, end], 시작 시각 순
let hitIdx = -1;

interface Loaded { trace: Trace; stats: FnStat[]; flame: FlameNode; times: Record<string, number> }

const hInfo = document.getElementById('hinfo')!;
const allocTable = document.getElementById('alloc')!;
let lk: Link | null = null; // 두 로그 연결 (같은 실행일 때만)
let focus: [number, number] | null = null; // 힙 블록을 클릭해 찾아간 구간 [스레드, 구간]. 흰 테두리로 표시
let allocs: FnAlloc[] = [];

// heap.bin: 파싱과 재생도 Worker에서 한다
function loadHeap(src: File | string, label: string) {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  w.postMessage({ kind: 'heap', src });
  w.onmessage = (e: MessageEvent<{ heap: Heap; times: Record<string, number> } | { error: string } | null>) => {
    w.terminate();
    if (!e.data) return void (hInfo.textContent = `${label}: 없음 — heap.bin을 드롭하세요`);
    if ('error' in e.data) return void (hInfo.textContent = `${label}: ${e.data.error}`);
    const h = e.data.heap;
    hInfo.textContent = `${label} — pid ${h.pid}, 레코드 ${h.records.toLocaleString()}개, 블록 ${h.count.toLocaleString()}개` +
      (h.unknownFrees ? `, 모르는 free ${h.unknownFrees}` : '');
    setHeap(h);
    pair();
  };
}

// 두 파일이 같은 실행에서 나왔는지: 트레이스 메인 스레드의 tid는 pid와 같다.
// 다르면 시각을 맞출 수 없으니 경고하고, 힙 시각은 heap.bin 시작 기준으로 보여 준다
function pair() {
  const h = hv.heap;
  if (!h || !trace) return;
  const same = trace.threads.some(th => th.tid === h.pid);
  hv.origin = same ? trace.start : NaN;
  hInfo.querySelector('.warn')?.remove();
  if (!same)
    hInfo.insertAdjacentHTML('beforeend', `<b class="warn"> ⚠ trace.json과 다른 실행입니다 (heap pid ${h.pid}) — 시각을 맞출 수 없습니다</b>`);
  // ponytail: 연결을 메인 스레드에서 한다. 샘플(블록 1만 3천 개)은 12ms. 수십만 블록이면 Worker로
  lk = same ? link(trace, h) : null;
  allocs = lk ? fnAllocs(trace, h, lk) : [];
  renderAllocs();
  highlight();
  hv.onTime();
}

// 함수별 할당: 함수가 실행 중일 때(자손 포함) 일어난 할당과, 그중 끝까지 해제 안 된 것
function renderAllocs() {
  if (!lk) return void (allocTable.innerHTML = `<tr><td class="cap">trace.json과 같은 실행의 heap.bin이 있어야 연결됩니다</td></tr>`);
  const rows = [...allocs].sort((a, b) => b.leakBytes - a.leakBytes || b.bytes - a.bytes).slice(0, 30);
  allocTable.innerHTML = `<tr><th>함수 (자손 포함)</th><th>할당</th><th>바이트</th><th>누수</th><th>누수 바이트</th></tr>` +
    rows.map(r => `<tr data-name="${esc(r.name)}"><td style="border-left:4px solid ${color(r.name)}">${esc(r.name)}</td>` +
      `<td>${r.allocs.toLocaleString()}</td><td>${kb(r.bytes)}</td><td>${r.leaks.toLocaleString()}</td><td>${kb(r.leakBytes)}</td></tr>`).join('');
}

// 검색어(= 선택한 함수)와 맞는 함수 아래에서 할당된 블록을 힙 지도에서 강조한다
function highlight() {
  const h = hv.heap;
  if (!lk || !h || !search.q) {
    hv.hl = null;
    hv.sel = '';
  } else {
    const pm = pathMatches(lk, matched);
    const hl = (hv.hl = new Uint8Array(h.count));
    let n = 0, bytes = 0, leaks = 0, leakBytes = 0;
    for (let b = 0; b < h.count; b++) {
      if (lk.path[b] < 0 || !pm[lk.path[b]]) continue;
      hl[b] = 1;
      n++;
      bytes += h.size[b];
      if (h.t1[b] === Infinity) (leaks++, (leakBytes += h.size[b]));
    }
    hv.sel = ` · 선택 ${q.value.trim()}: 할당 ${n.toLocaleString()}회 ${kb(bytes)}, 누수 ${leaks.toLocaleString()}개 ${kb(leakBytes)}`;
  }
  drawHeap();
}

// 블록 → 할당 순간의 호출 경로
hv.describe = b => (!lk || !trace ? '' : lk.path[b] < 0 ? '(트레이스 밖에서 할당)' : pathText(trace, lk, lk.path[b]));

// 블록 클릭 → 그 블록을 할당한 함수 호출로 타임라인을 옮기고 그 함수를 선택한다
hv.onBlockClick = b => {
  if (!lk || !trace || lk.span[b] < 0) return;
  const th = trace.threads[lk.thread[b]], i = lk.span[b];
  const pad = Math.max((th.end[i] - th.start[i]) * 2, 2);
  [t0, t1] = [th.start[i] - pad, th.end[i] + pad];
  select(trace.names[th.name[i]], false);
  focus = [lk.thread[b], i];
};

// 함수 하나를 선택: 검색창에 "이름"(정확히 일치)을 넣는다. 같은 걸 다시 고르면 해제
function select(name: string, toggle = true) {
  const v = `"${name}"`;
  q.value = toggle && q.value === v ? '' : v;
  setQuery(q.value);
}

// 힙 슬라이더 시각을 타임라인에 세로선으로 보여 준다 (두 로그는 같은 CLOCK_MONOTONIC)
hv.onTime = () => (dirty = true);

// 파싱과 분석은 Worker에서 한다. 그동안 메인 스레드는 화면을 계속 그린다
function load(src: File | string, label: string) {
  const t = performance.now();
  info.textContent = `${label} 불러오는 중…`;
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  w.postMessage({ kind: 'trace', src });
  w.onmessage = (e: MessageEvent<Loaded | null>) => {
    w.terminate();
    if (!e.data) return void (info.textContent = `${label}: 읽지 못함 — trace.json을 이 창에 드롭하세요`);
    ({ trace, stats } = e.data);
    pair();
    const tr = trace!;
    const stages = Object.entries(e.data.times).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ');
    info.textContent = `${label} — 스레드 ${tr.threads.length}개, 함수 호출 ${tr.count.toLocaleString()}개, ` +
      `로딩 ${(performance.now() - t).toFixed(0)}ms (${stages})`;
    laneTop = [];
    let y = AXIS;
    for (const th of tr.threads) {
      laneTop.push(y);
      y += LANE_HEAD + th.rows.length * ROW;
    }
    colors = tr.names.map(color);
    // 'hsl(...)'을 캔버스에 넣었다 빼면 '#rrggbb'가 나온다. ImageData(리틀 엔디언 ABGR)용 정수로 바꾼다
    rgba = Uint32Array.from(colors, c => {
      ctx.fillStyle = c;
      const v = parseInt((ctx.fillStyle as string).slice(1), 16);
      return (0xff << 24) | ((v & 0xff) << 16) | (v & 0xff00) | (v >> 16);
    });
    setFlame(e.data.flame);
    renderTable();
    setQuery(q.value);
    resetView();
  };
}

// 느린 함수 Top 10. self%가 높으면 자기 코드가 느린 것이고, 낮으면 자식 호출이 시간을 먹는 것이다
function renderTable() {
  const rows = [...stats].sort((a, b) => b[sortKey] - a[sortKey]).slice(0, 10);
  const th = (k: typeof sortKey, text: string) => `<th data-sort="${k}" class="${k === sortKey ? 'on' : ''}">${text}</th>`;
  table.innerHTML =
    `<tr><th>함수</th><th>호출</th>${th('self', 'self')}${th('total', 'total')}<th>self%</th></tr>` +
    rows.map(r => `<tr data-name="${esc(r.name)}"><td style="border-left:4px solid ${color(r.name)}">${esc(r.name)}</td>` +
      `<td>${r.calls.toLocaleString()}</td><td>${fmt(r.self)}</td><td>${fmt(r.total)}</td>` +
      `<td>${r.total ? ((r.self / r.total) * 100).toFixed(0) : 0}%</td></tr>`).join('');
}

// C++ 함수 이름(std::vector<int> 등)에 들어 있는 <, >, & 때문에 HTML이 깨지지 않게 한다
const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

table.addEventListener('click', e => {
  const el = e.target as HTMLElement;
  const sort = el.closest('th')?.dataset.sort;
  if (sort) {
    sortKey = sort as typeof sortKey;
    return renderTable();
  }
  const name = el.closest('tr')?.dataset.name;
  if (name) select(name);
});

allocTable.addEventListener('click', e => {
  const name = (e.target as HTMLElement).closest('tr')?.dataset.name;
  if (name && name !== '(트레이스 밖)') select(name);
});

function setQuery(v: string) {
  setSearch(v);
  hits = [];
  if (trace) {
    matched = Uint8Array.from(trace.names, n => +matches(n));
    if (search.q)
      for (const th of trace.threads)
        for (let i = 0; i < th.start.length; i++) if (matched[th.name[i]]) hits.push([th.start[i], th.end[i]]);
    if (trace.threads.length > 1) hits.sort((a, b) => a[0] - b[0]);
  }
  hitIdx = -1;
  qInfo.textContent = search.q ? `${hits.length.toLocaleString()}건` : '';
  dirty = true;
  drawFlame();
  highlight();
}

// Enter: 다음 일치 구간으로 이동 (Shift+Enter: 이전)
function jump(dir: number) {
  if (!hits.length) return;
  hitIdx = (hitIdx + dir + hits.length) % hits.length;
  const [s, e] = hits[hitIdx];
  const pad = Math.max((e - s) * 0.5, 1);
  [t0, t1] = [s - pad, e + pad];
  qInfo.textContent = `${hitIdx + 1} / ${hits.length.toLocaleString()}건`;
  dirty = true;
}

q.addEventListener('input', () => setQuery(q.value));
q.addEventListener('keydown', e => {
  if (e.key === 'Enter') jump(e.shiftKey ? -1 : 1);
  if (e.key === 'Escape') {
    q.value = '';
    setQuery('');
  }
});

function resetView() {
  if (!trace) return;
  [t0, t1] = [trace.start, trace.end];
  dirty = true;
}

let img: ImageData | null = null, px32 = new Uint32Array(0);
let rgba = new Uint32Array(0); // 이름 id → ImageData용 색 (검색 불일치면 흐리게)

function draw() {
  const [W] = fit(canvas, ctx);
  if (!trace) return;
  const scale = W / (t1 - t0), dpr = devicePixelRatio;
  if (!img || img.width !== canvas.width || img.height !== canvas.height) {
    img = ctx.createImageData(canvas.width, canvas.height);
    px32 = new Uint32Array(img.data.buffer);
  } else px32.fill(0);

  // 1px보다 좁은 칸은 캔버스 API 대신 픽셀 버퍼에 직접 쓴다.
  // 칸마다 fillRect/Path2D.rect를 부르면 1만 3천 칸에 16ms가 들었다 (프레임 예산 전부)
  const cell = (id: number, px: number, y: number) => {
    if (px < 0 || px >= W) return;
    const c = matched[id] ? rgba[id] : rgba[id] & 0x33ffffff;
    const x0 = Math.round(px * dpr), x1 = Math.round((px + 1) * dpr);
    const y1 = Math.min(img!.height, Math.round((y + ROW - 1) * dpr));
    // 한 번에 1~2픽셀이라 px32.fill()을 부르면 호출 오버헤드가 더 크다 (20만 번에 20ms)
    for (let yy = Math.round(y * dpr), stride = img!.width; yy < y1; yy++)
      for (let o = yy * stride + x0, e = yy * stride + x1; o < e; o++) px32[o] = c;
  };
  const wide: [number, number, number, number][] = [];

  trace.threads.forEach((th, n) => {
    th.rows.forEach((idx, d) => {
      const y = laneTop[n] + LANE_HEAD + d * ROW;
      // 같은 깊이 구간은 겹치지 않고 end도 오름차순이라, 화면 왼쪽 끝에 걸친 첫 구간을 이진 탐색으로 찾는다
      let k = lowerBound(idx, th.end, t0);
      while (k < idx.length) {
        const i = idx[k], s = th.start[i];
        if (s > t1) break;
        const x = (s - t0) * scale, w = (th.end[i] - s) * scale, id = th.name[i];
        if (w >= 1) {
          wide.push([id, x, y, w]);
          k++;
          continue;
        }
        // LOD: 1px보다 좁은 구간은 이 픽셀 칸에서 시작하는 것들을 한 칸으로 합쳐 한 번만 그린다.
        // 그래서 한 줄을 그리는 비용이 보이는 구간 수가 아니라 화면 폭(px)에 비례한다
        const px = Math.floor(x);
        const next = t0 + (px + 1) / scale;
        const k2 = lowerBound(idx, th.start, next, k + 1);
        // 칸 색은 첫 구간 것. 검색 중에는 칸 안에 숨은 일치 구간이 있으면 그걸로 칠해 강조가 사라지지 않게 한다
        let cid = id;
        if (hits.length && !matched[id])
          for (let j = k + 1; j < k2; j++)
            if (matched[th.name[idx[j]]]) {
              cid = th.name[idx[j]];
              break;
            }
        cell(cid, px, y);
        // 건너뛴 것 중 마지막 구간은 다음 칸까지 이어질 수 있으니 그건 따로 그린다
        k = k2 - 1 > k && th.end[idx[k2 - 1]] > next ? k2 - 1 : k2;
      }
    });
  });
  // putImageData는 영역의 픽셀을 통째로 덮어쓰므로 나머지는 전부 이 뒤에 그린다
  ctx.putImageData(img, 0, 0);

  for (const [id, x, y, w] of wide) {
    ctx.globalAlpha = matched[id] ? 1 : 0.2;
    ctx.fillStyle = colors[id];
    ctx.fillRect(x, y, w, ROW - 1);
  }
  ctx.globalAlpha = 1;
  for (const [id, x, y, w] of wide) label(ctx, trace.names[id], x, y, w, ROW);
  if (focus) {
    const [n, i] = focus, th = trace.threads[n];
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect((th.start[i] - t0) * scale, laneTop[n] + LANE_HEAD + th.depth[i] * ROW, Math.max(2, (th.end[i] - th.start[i]) * scale), ROW - 1);
  }

  trace.threads.forEach((th, n) => {
    ctx.fillStyle = '#2b2f38';
    ctx.fillRect(0, laneTop[n], W, 1);
    ctx.fillStyle = '#88c0d0';
    ctx.fillText(`tid ${th.tid}`, 4, laneTop[n] + LANE_HEAD / 2);
  });

  if (!isNaN(hv.origin) && hv.t <= trace.end) {
    ctx.fillStyle = '#e5484d';
    ctx.fillRect((hv.t - t0) * scale, AXIS, 1, canvas.clientHeight - AXIS);
  }

  // 시간 축: 화면에 눈금 10개 안팎이 오도록 1·2·5 단위로 고른다
  const raw = (t1 - t0) / 10, p = 10 ** Math.floor(Math.log10(raw));
  const step = raw / p < 2 ? p : raw / p < 5 ? 2 * p : 5 * p;
  const [unit, div] = step >= 1e5 ? ['s', 1e6] : step >= 100 ? ['ms', 1e3] : ['µs', 1];
  const digits = Math.max(0, -Math.floor(Math.log10(step / div)));
  ctx.fillStyle = '#7b8394';
  let labelEnd = -Infinity; // 라벨이 길어 앞 라벨과 겹치면 눈금만 긋고 글자는 건너뛴다
  for (let r = Math.ceil((t0 - trace.start) / step) * step; r + trace.start < t1; r += step) {
    const x = (r + trace.start - t0) * scale, text = `${(r / div).toFixed(digits)} ${unit}`;
    ctx.fillRect(x, AXIS - 6, 1, 6);
    if (x + 3 < labelEnd) continue;
    ctx.fillText(text, x + 3, 8);
    labelEnd = x + 3 + ctx.measureText(text).width + 8;
  }
}

function frame() {
  if (dirty) {
    dirty = false;
    draw();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
new ResizeObserver(() => (dirty = true)).observe(canvas);

function spanAt(px: number, py: number): [number, number] | null {
  if (!trace) return null;
  const t = t0 + (px / canvas.clientWidth) * (t1 - t0);
  const tol = (t1 - t0) / canvas.clientWidth; // 1px보다 얇은 구간도 잡히게
  for (let n = 0; n < trace.threads.length; n++) {
    const idx = trace.threads[n].rows[Math.floor((py - laneTop[n] - LANE_HEAD) / ROW)];
    if (!idx) continue;
    const th = trace.threads[n];
    const k = lowerBound(idx, th.end, t - tol);
    if (k < idx.length && th.start[idx[k]] - tol <= t) return [n, idx[k]];
  }
  return null;
}

// 줌: 커서 위치의 시각을 고정한 채 범위를 늘리고 줄인다
canvas.addEventListener('wheel', e => {
  if (!trace) return;
  e.preventDefault();
  const f = Math.exp(e.deltaY * 0.002);
  const at = t0 + (e.offsetX / canvas.clientWidth) * (t1 - t0);
  const span = Math.max(0.01, Math.min(trace.end - trace.start, (t1 - t0) * f));
  t0 = at - (at - t0) * (span / (t1 - t0));
  t1 = t0 + span;
  dirty = true;
}, { passive: false });

let dragX: number | null = null, downX = 0, downY = 0;
canvas.addEventListener('mousedown', e => {
  dragX = downX = e.clientX;
  downY = e.clientY;
});
addEventListener('mouseup', () => (dragX = null));
// 클릭(끌지 않고 놓음): 그 함수를 선택한다. 힙 지도가 있으면 그 함수가 할당한 블록이 강조된다
canvas.addEventListener('click', e => {
  if (!trace || Math.abs(e.clientX - downX) > 3 || Math.abs(e.clientY - downY) > 3) return;
  const hit = spanAt(e.offsetX, e.offsetY);
  if (!hit) return;
  select(trace.names[trace.threads[hit[0]].name[hit[1]]]);
  focus = null;
  if (lk) showTab('heapview');
});
addEventListener('mousemove', e => {
  if (dragX === null) return;
  const dt = ((e.clientX - dragX) / canvas.clientWidth) * (t1 - t0);
  t0 -= dt;
  t1 -= dt;
  dragX = e.clientX;
  dirty = true;
});
canvas.addEventListener('dblclick', resetView);

canvas.addEventListener('mousemove', e => {
  const hit = dragX === null ? spanAt(e.offsetX, e.offsetY) : null;
  if (!hit || !trace) return showTip(e, null);
  const th = trace.threads[hit[0]], i = hit[1];
  showTip(e, `${trace.names[th.name[i]]}\n${fmt(th.end[i] - th.start[i])}\ntid ${th.tid}, depth ${th.depth[i]}`);
});
canvas.addEventListener('mouseleave', e => showTip(e, null));

addEventListener('dragover', e => {
  e.preventDefault();
  document.body.classList.add('drag');
});
addEventListener('dragleave', () => document.body.classList.remove('drag'));
addEventListener('drop', e => {
  e.preventDefault();
  document.body.classList.remove('drag');
  // trace.json과 heap.bin을 함께 드롭할 수 있다
  for (const file of e.dataTransfer?.files ?? []) {
    if (file.name.endsWith('.bin')) loadHeap(file, file.name);
    else load(file, file.name);
  }
});

// 개발 편의: public/trace.json이 있으면 바로 연다
load(new URL('trace.json', location.href).href, 'public/trace.json');
loadHeap(new URL('heap.bin', location.href).href, 'public/heap.bin');

// 아래 패널 탭: 분석(플레임 그래프·Top 10) / 힙 지도
function showTab(tab: string) {
  for (const b of document.querySelectorAll<HTMLElement>('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const p of document.querySelectorAll<HTMLElement>('.tab')) p.hidden = p.id !== tab;
}
document.getElementById('tabs')!.addEventListener('click', e => {
  const tab = (e.target as HTMLElement).dataset.tab;
  if (tab) showTab(tab);
});
