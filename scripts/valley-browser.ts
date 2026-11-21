// Start pnpm dev --port 5198, then pnpm exec tsx scripts/valley-browser.ts.
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({
  args: process.platform === 'darwin' ? ['--enable-gpu', '--use-angle=metal'] : ['--enable-gpu'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.error(error));
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: URL | string, options?: WorkerOptions) {
        super(String(url).includes('sim.worker') ? '/scripts/valley-benchmark.worker.ts' : url, options);
        window.addEventListener('valley-grow', (event) =>
          this.postMessage({ type: 'growTo', target: (event as CustomEvent<number>).detail }),
        );
      }
    };
  });
  await page.goto((process.env.VALLEY_URL ?? 'http://localhost:5198') + '/?scenario=valley&speed=8');
  await mkdir('artifacts/screens', { recursive: true });
  for (const target of [150, 500, 1000]) {
    if (target !== 150)
      await page.evaluate((n) => window.dispatchEvent(new CustomEvent('valley-grow', { detail: n })), target);
    await page.waitForFunction((n) => (window.__towns?.town()?.households.length ?? 0) >= n, target, {
      timeout: 1200000,
    });
    await page.evaluate((n) => window.__towns!.setSpeed(n === 1000 ? 1 : 8), target);
    const client = process.env.VALLEY_PROFILE ? await page.context().newCDPSession(page) : undefined;
    if (client) {
      await client.send('Profiler.enable');
      await client.send('Profiler.start');
    }
    const result = await page.evaluate(async () => {
      const game = window.__towns!;
      const start = performance.now(),
        tick = game.stats()!.tick;
      let frames = 0;
      do {
        await new Promise(requestAnimationFrame);
        frames++;
      } while (performance.now() - start < 5000);
      const seconds = (performance.now() - start) / 1000;
      return {
        homes: game.town()!.households.length,
        fps: frames / seconds,
        tps: (game.stats()!.tick - tick) / seconds,
        lost: game.stats()!.lost,
      };
    });
    if (client) {
      const { profile } = await client.send('Profiler.stop');
      const { writeFile } = await import('node:fs/promises');
      await writeFile('artifacts/valley-' + target + '.cpuprofile', JSON.stringify(profile));
      await client.detach();
    }
    console.log(JSON.stringify({ target, ...result }));
    if (!result.tps || result.lost) throw new Error('Invalid live sample');
    if (target === 500) {
      await page.evaluate(() => window.__towns!.setSpeed(0));
      const zoom = async (deltaY: number) =>
        page.evaluate((d) => {
          document
            .querySelector('canvas')!
            .dispatchEvent(new WheelEvent('wheel', { clientX: 510, clientY: 515, deltaY: d }));
        }, deltaY);
      await page.screenshot({ path: 'artifacts/screens/valley-500.png' });
      await zoom(-430);
      await page.evaluate(() => window.__towns!.setTrafficView(true));
      await page.screenshot({ path: 'artifacts/screens/valley-traffic.png' });
      await page.evaluate(() => window.__towns!.setTrafficView(false));
      await zoom(430);
    }
  }
} finally {
  await browser.close();
}
