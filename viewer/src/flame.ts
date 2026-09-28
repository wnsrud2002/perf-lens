// 플레임 그래프(위에서 아래로 자라는 아이시클 형태). 폭 = 그 호출 스택의 total 시간.
// 클릭: 그 노드를 루트로 확대. 맨 윗줄 클릭: 한 단계 위로.
import type { FlameNode } from './analyze.ts';
import { color, fit, fmt, label, matches, showTip } from './util.ts';

const ROW = 16;
const canvas = document.getElementById('flame') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

let all: FlameNode | null = null;
let focus: FlameNode | null = null;
let boxes: { x: number; y: number; w: number; n: FlameNode }[] = [];

export function setFlame(root: FlameNode) {
  all = focus = root;
  drawFlame();
}

export function drawFlame() {
  const [W] = fit(canvas, ctx);
  boxes = [];
  if (!focus || !all) return;
  const scale = W / focus.total;
  const walk = (n: FlameNode, x: number, depth: number) => {
    const w = n.total * scale;
    if (w < 0.5) return;
    const y = depth * ROW;
    boxes.push({ x, y, w, n });
    ctx.globalAlpha = matches(n.name) ? 1 : 0.25;
    ctx.fillStyle = n === all ? '#4c566a' : color(n.name);
    ctx.fillRect(x, y, Math.max(1, w - 1), ROW - 1);
    ctx.globalAlpha = 1;
    label(ctx, n.name, x, y, w, ROW);
    let cx = x;
    for (const c of [...n.children.values()].sort((a, b) => b.total - a.total)) {
      walk(c, cx, depth + 1);
      cx += c.total * scale;
    }
  };
  walk(focus, 0, 0);
}

const hit = (e: MouseEvent) => boxes.find(b => e.offsetX >= b.x && e.offsetX < b.x + b.w && e.offsetY >= b.y && e.offsetY < b.y + ROW);

canvas.addEventListener('click', e => {
  const b = hit(e);
  if (!b) return;
  focus = b.n === focus ? focus.parent ?? focus : b.n;
  drawFlame();
});

canvas.addEventListener('mousemove', e => {
  const b = hit(e);
  if (!b || !all) return showTip(e, null);
  const n = b.n;
  const pct = ((n.total / all.total) * 100).toFixed(1);
  const path: string[] = [];
  for (let p: FlameNode | null = n; p && p !== all; p = p.parent) path.unshift(p.name);
  showTip(e, `${path.join(' → ') || 'all'}\ntotal ${fmt(n.total)} (${pct}%)\nself  ${fmt(n.self)}`);
});
canvas.addEventListener('mouseleave', e => showTip(e, null));
new ResizeObserver(drawFlame).observe(canvas);
