import type { FlameNode, FnStat } from './analyze.ts';
import { drawFlame, setFlame } from './flame.ts';
import { lowerBound, type Trace } from './parse.ts';
import { color, fit, fmt, label, matches, search, showTip } from './util.ts';

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

// 파싱과 분석은 Worker에서 한다. 그동안 메인 스레드는 화면을 계속 그린다
function load(src: File | string, label: string) {
  const t = performance.now();
  info.textContent = `${label} 불러오는 중…`;
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  w.postMessage(src);
  w.onmessage = (e: MessageEvent<Loaded | null>) => {
    w.terminate();
    if (!e.data) return void (info.textContent = `${label}: 읽지 못함 — trace.json을 이 창에 드롭하세요`);
    ({ trace, stats } = e.data);
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
  if (name) {
    q.value = name === search.q ? '' : name;
    setQuery(q.value);
  }
});

function setQuery(v: string) {
  search.q = v.trim().toLowerCase();
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

  trace.threads.forEach((th, n) => {
    ctx.fillStyle = '#2b2f38';
    ctx.fillRect(0, laneTop[n], W, 1);
    ctx.fillStyle = '#88c0d0';
    ctx.fillText(`tid ${th.tid}`, 4, laneTop[n] + LANE_HEAD / 2);
  });

  // 시간 축: 화면에 눈금 10개 안팎이 오도록 1·2·5 단위로 고른다
  const raw = (t1 - t0) / 10, p = 10 ** Math.floor(Math.log10(raw));
  const step = raw / p < 2 ? p : raw / p < 5 ? 2 * p : 5 * p;
  const [unit, div] = step >= 1e5 ? ['s', 1e6] : step >= 100 ? ['ms', 1e3] : ['µs', 1];
  const digits = Math.max(0, -Math.floor(Math.log10(step / div)));
  ctx.fillStyle = '#7b8394';
  for (let r = Math.ceil((t0 - trace.start) / step) * step; r + trace.start < t1; r += step) {
    const x = (r + trace.start - t0) * scale;
    ctx.fillRect(x, AXIS - 6, 1, 6);
    ctx.fillText(`${(r / div).toFixed(digits)} ${unit}`, x + 3, 8);
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

let dragX: number | null = null;
canvas.addEventListener('mousedown', e => (dragX = e.clientX));
addEventListener('mouseup', () => (dragX = null));
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
  const file = e.dataTransfer?.files[0];
  if (file) load(file, file.name);
});

// 개발 편의: public/trace.json이 있으면 바로 연다
load(new URL('trace.json', location.href).href, 'public/trace.json');
