// 뷰어 성능 측정: node bench.mjs <trace.json> [반복 횟수]
// 먼저 npm run build. dist를 띄우고 headless Chromium으로 로딩 시간, UI 멈춤, 줌·팬 프레임 간격, JS 힙을 잰다.
import { rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';

const [file, runs = '3'] = process.argv.slice(2);
if (!file) throw new Error('usage: node bench.mjs <trace.json> [runs]');

// route.fulfill은 100MB급 응답에서 페이지가 죽는다. dist에 링크를 걸어 서버가 직접 서빙하게 한다
rmSync('dist/trace.json', { force: true });
symlinkSync(resolve(file), 'dist/trace.json');
const server = await preview({ preview: { port: 4174, strictPort: true }, logLevel: 'silent' });
const browser = await chromium.launch();
const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

// 매 프레임 이벤트 하나를 넣어 '계속 줌/팬하는 중'을 만들고 rAF 간격을 잰다.
// (Playwright가 이벤트를 하나씩 보내면 다시 그리지 않는 빈 프레임이 섞여 수치가 좋게 나온다)
function frames(page, kind) {
  return page.evaluate(kind => new Promise(res => {
    const c = document.getElementById('c'), r = c.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + 100, bubbles: true };
    const n = 80, ts = [];
    if (kind === 'pan') c.dispatchEvent(new MouseEvent('mousedown', at));
    const f = t => {
      ts.push(t);
      const i = ts.length;
      if (kind === 'zoom') c.dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: i <= n / 2 ? -25 : 25, cancelable: true }));
      else dispatchEvent(new MouseEvent('mousemove', { ...at, clientX: at.clientX + (i % 20 < 10 ? 1 : -1) * 15 * (i % 10) }));
      if (i <= n) requestAnimationFrame(f);
      else {
        dispatchEvent(new MouseEvent('mouseup', at));
        res(ts.slice(2).map((t, i) => t - ts[i + 1]));
      }
    };
    requestAnimationFrame(f);
  }), kind);
}

async function once() {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  // vite preview는 응답을 즉석에서 gzip한다(104MB에 3초 이상). 파일 드롭과 조건을 맞추려고 압축을 끈다
  await page.setExtraHTTPHeaders({ 'Accept-Encoding': 'identity' });
  // 로딩 중 메인 스레드가 얼마나 오래 멈추는지: 가장 긴 rAF 간격
  await page.addInitScript(() => {
    window.__gaps = [];
    let last = 0;
    const f = t => { if (last) window.__gaps.push(t - last); last = t; if (!window.__loaded) requestAnimationFrame(f); };
    requestAnimationFrame(f);
  });
  await page.goto(`http://localhost:4174/`);
  await page.waitForFunction(() => document.getElementById('info').textContent.includes('함수 호출'), null, { timeout: 300_000 });
  const load = await page.evaluate(() => new Promise(r => requestAnimationFrame(() => ((window.__loaded = true), r(performance.now())))));
  const freeze = await page.evaluate(() => Math.max(0, ...window.__gaps));
  const info = await page.textContent('#info');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  // TypedArray 데이터는 JS 힙 밖(ArrayBuffer 저장소)에 있으므로 함께 더한다
  const u = await cdp.send('Runtime.getHeapUsage');
  const heap = (u.usedSize + u.backingStorageSize) / 2 ** 20;

  const zoom = await frames(page, 'zoom'); // 전체 보기에서 확대했다가 다시 축소
  const pan = await frames(page, 'pan');
  await page.close();
  return { load, freeze, heap, zoom, pan, info };
}

const rs = [];
for (let i = 0; i < +runs; i++) rs.push(await once());
console.log(rs[0].info);
const row = (k, f) => console.log(k.padEnd(28), f);
row('로딩 → 첫 화면 (ms)', rs.map(r => r.load.toFixed(0)).join(' / '));
row('로딩 중 최장 멈춤 (ms)', rs.map(r => r.freeze.toFixed(0)).join(' / '));
row('JS 메모리, GC 후 (MB)', rs.map(r => r.heap.toFixed(0)).join(' / '));
const z = rs.flatMap(r => r.zoom), p = rs.flatMap(r => r.pan);
row('줌 프레임 ms (중앙/p95)', `${med(z).toFixed(1)} / ${pct(z, 0.95).toFixed(1)}  → ${(1000 / med(z)).toFixed(0)} fps`);
row('팬 프레임 ms (중앙/p95)', `${med(p).toFixed(1)} / ${pct(p, 0.95).toFixed(1)}  → ${(1000 / med(p)).toFixed(0)} fps`);
await browser.close();
await server.close();
rmSync('dist/trace.json');
