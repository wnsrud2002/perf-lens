import { analyze, type FnStat } from './analyze.ts';
import { drawFlame, setFlame } from './flame.ts';
import { parseTrace, type Span, type Thread, type Trace } from './parse.ts';
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
let hits: Span[] = []; // 검색어와 일치하는 구간, 시작 시각 순
let hitIdx = -1;

function load(json: any, label: string) {
  const t = performance.now();
  trace = parseTrace(json);
  const ms = (performance.now() - t).toFixed(0);
  const n = trace.threads.reduce((a, th) => a + th.spans.length, 0);
  info.textContent = `${label} — 스레드 ${trace.threads.length}개, 함수 호출 ${n.toLocaleString()}개, 파싱 ${ms}ms`;
  laneTop = [];
  let y = AXIS;
  for (const th of trace.threads) {
    laneTop.push(y);
    y += LANE_HEAD + (th.maxDepth + 1) * ROW;
  }
  const a = analyze(trace);
  stats = a.stats;
  setFlame(a.flame);
  renderTable();
  setQuery(q.value);
  resetView();
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
  hits = search.q && trace ? trace.threads.flatMap(th => th.spans.filter(s => matches(s.name))).sort((a, b) => a.start - b.start) : [];
  hitIdx = -1;
  qInfo.textContent = search.q ? `${hits.length.toLocaleString()}건` : '';
  dirty = true;
  drawFlame();
}

// Enter: 다음 일치 구간으로 이동 (Shift+Enter: 이전)
function jump(dir: number) {
  if (!hits.length) return;
  hitIdx = (hitIdx + dir + hits.length) % hits.length;
  const s = hits[hitIdx];
  const pad = Math.max((s.end - s.start) * 0.5, 1);
  [t0, t1] = [s.start - pad, s.end + pad];
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

function draw() {
  const [W] = fit(canvas, ctx);
  if (!trace) return;
  const scale = W / (t1 - t0);

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

  trace.threads.forEach((th, i) => {
    const top = laneTop[i];
    ctx.fillStyle = '#2b2f38';
    ctx.fillRect(0, top, W, 1);
    ctx.fillStyle = '#88c0d0';
    ctx.fillText(`tid ${th.tid}`, 4, top + LANE_HEAD / 2);
    // ponytail: 전 구간 선형 스캔. 3주차에 시간축 이진 탐색 + LOD로 교체
    for (const s of th.spans) {
      if (s.end < t0 || s.start > t1) continue;
      const x = (s.start - t0) * scale;
      const w = Math.max(1, (s.end - s.start) * scale);
      const y = top + LANE_HEAD + s.depth * ROW;
      ctx.globalAlpha = matches(s.name) ? 1 : 0.2;
      ctx.fillStyle = color(s.name);
      ctx.fillRect(x, y, w, ROW - 1);
      ctx.globalAlpha = 1;
      label(ctx, s.name, x, y, w, ROW);
    }
  });
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

function spanAt(px: number, py: number): [Thread, Span] | null {
  if (!trace) return null;
  const t = t0 + (px / canvas.clientWidth) * (t1 - t0);
  const tol = (t1 - t0) / canvas.clientWidth; // 1px보다 얇은 구간도 잡히게
  for (let i = 0; i < trace.threads.length; i++) {
    const th = trace.threads[i];
    const depth = Math.floor((py - laneTop[i] - LANE_HEAD) / ROW);
    if (depth < 0 || depth > th.maxDepth) continue;
    const s = th.spans.find(s => s.depth === depth && s.start - tol <= t && t <= s.end + tol);
    if (s) return [th, s];
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
  showTip(e, hit && `${hit[1].name}\n${fmt(hit[1].end - hit[1].start)}\ntid ${hit[0].tid}, depth ${hit[1].depth}`);
});
canvas.addEventListener('mouseleave', e => showTip(e, null));

addEventListener('dragover', e => {
  e.preventDefault();
  document.body.classList.add('drag');
});
addEventListener('dragleave', () => document.body.classList.remove('drag'));
addEventListener('drop', async e => {
  e.preventDefault();
  document.body.classList.remove('drag');
  const file = e.dataTransfer?.files[0];
  if (file) load(JSON.parse(await file.text()), file.name);
});

// 개발 편의: public/trace.json이 있으면 바로 연다
fetch('trace.json')
  .then(r => (r.ok ? r.json() : null))
  .then(j => j && load(j, 'public/trace.json'))
  .catch(() => {});
