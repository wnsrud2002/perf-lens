export function fmt(us: number) {
  if (us >= 1e6) return (us / 1e6).toFixed(3) + ' s';
  if (us >= 1e3) return (us / 1e3).toFixed(3) + ' ms';
  return us.toFixed(3) + ' µs';
}

const colorCache = new Map<string, string>();
export function color(name: string) {
  let c = colorCache.get(name);
  if (!c) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    c = `hsl(${(h >>> 0) % 360} 55% 45%)`;
    colorCache.set(name, c);
  }
  return c;
}

// 검색어: 비어 있으면 모두 일치. 대소문자 무시 부분 일치, "따옴표"로 감싸면 정확히 일치
// (타임라인에서 함수를 클릭하면 "이름"으로 들어간다. free를 골랐는데 free_request까지 잡히지 않게)
export const search = { q: '', exact: false };
export function setSearch(v: string) {
  const m = v.trim().match(/^"(.*)"$/);
  search.exact = !!m;
  search.q = (m ? m[1] : v.trim()).toLowerCase();
}
export const matches = (name: string) =>
  !search.q || (search.exact ? name.toLowerCase() === search.q : name.toLowerCase().includes(search.q));

// 캔버스 크기를 CSS 크기 × devicePixelRatio에 맞추고 CSS 픽셀 좌표계로 되돌린다
export function fit(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
  const dpr = devicePixelRatio;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'middle';
  return [W, H];
}

export function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, h: number) {
  if (w <= 30) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = '#fff';
  ctx.fillText(text, Math.max(x, 0) + 3, y + h / 2);
  ctx.restore();
}

const tip = document.getElementById('tip')!;
export function showTip(e: MouseEvent, text: string | null) {
  if (!text) {
    tip.style.display = 'none';
    return;
  }
  tip.textContent = text;
  tip.style.display = 'block';
  tip.style.left = e.clientX + 12 + 'px';
  tip.style.top = e.clientY + 12 + 'px';
}
