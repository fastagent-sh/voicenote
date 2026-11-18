import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runAsync } from '../../src/testing/fakeModel.ts'

test.skipIf(process.platform !== 'darwin')('queued recordings can be prioritized and removed from the UI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vn-queue-ui-'))
  try {
    await writeFile(join(dir, 'entry.ts'), `
import { createElement } from ${JSON.stringify(resolve('desktop/node_modules/react/index.js'))}
import { createRoot } from ${JSON.stringify(resolve('desktop/node_modules/react-dom/client.js'))}
import { App } from ${JSON.stringify(resolve('desktop/src/renderer/src/App.tsx'))}
createRoot(document.getElementById('root')!).render(createElement(App))
`)
    const build = await Bun.build({ entrypoints: [join(dir, 'entry.ts')], outdir: dir, target: 'browser', naming: 'renderer.js' })
    expect(build.success, String(build.logs)).toBe(true)

    await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><div id="root"></div><script>
window.listeners = {};
window.prioritized = [];
window.removed = [];
window.aborted = 0;
window.pending = { deletes: [], priorities: {} };
window.items = [
  { id: 'r1', status: 'running', name: 'r1.mp3', title: 'Running Meeting', time: '2026-07-01 09:00', step: 'transcribe', durationSeconds: 300, imported: false, priority: 0 },
  { id: 'q1', status: 'queued', name: 'q1.mp3', title: 'First Queued', time: '2026-07-01 10:00', durationSeconds: 180, imported: false, priority: 0 },
  { id: 'q2', status: 'queued', name: 'q2.mp3', title: 'Second Queued', time: '2026-07-01 11:00', durationSeconds: 240, imported: true, priority: 0 },
];
window.vn = {
  status: async () => ({ recorder: { exists: true }, volcano: { configured: true }, pi: { available: true, auth: true }, summary: { model: 'test' } }),
  jobs: async () => ({ items: window.items, total: window.items.length, queued_total: 3, recorder_present: true }),
  pendingRetries: async () => [],
  pendingQueue: async () => window.pending,
  updateState: async () => ({}),
  search: async () => [],
  prioritizeJob: async (id) => {
    window.prioritized.push(id);
    window.pending = { ...window.pending, priorities: { ...window.pending.priorities, [id]: Date.now() } };
    window.listeners['queue:pending']?.(window.pending);
    return { queued: true };
  },
  removeQueuedJob: async (id) => {
    window.removed.push(id);
    window.pending = { ...window.pending, deletes: [...window.pending.deletes, id] };
    window.listeners['queue:pending']?.(window.pending);
    return { queued: true };
  },
  abortCurrentJob: async () => {
    window.aborted++;
    return { aborted: true };
  },
  on: (key, fn) => { window.listeners[key] = fn; return () => {} },
};
</script><script src="renderer.js"></script>`)

    await writeFile(join(dir, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  win.webContents.on('console-message', e => console.error(e.message));
  await win.loadFile(${JSON.stringify(join(dir, 'index.html'))});
  await win.webContents.executeJavaScript(\`(async () => {
    const check = (ok, why) => { if (!ok) throw Error(why) };
    const tick = () => new Promise(r => setTimeout(r, 30));
    const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
    const queuedTitles = () => [...document.querySelectorAll('.row-queued .row-title')].map(el => el.textContent.trim());

    for (let i = 0; i < 50 && queuedTitles().length < 2; i++) await tick();
    window.listeners['run:state']?.({ running: true });
    await tick();

    check(queuedTitles()[0].includes('First Queued'), 'expected First Queued first, got: ' + queuedTitles().join(', '));
    // Verify active job shows abort-and-move-to-tail action
    check(button('中止并移到队尾'), 'ActiveDetail did not render abort button');
    button('中止并移到队尾').click();
    await tick();
    check(window.aborted === 1 && button('正在中止…')?.disabled, 'abortCurrentJob did not trigger loading state');
    window.items = [
      { id: 'q1', status: 'running', name: 'q1.mp3', title: 'First Queued', time: '2026-07-01 10:00', step: 'transcribe', durationSeconds: 180, imported: false, priority: 0 },
      { id: 'q2', status: 'queued', name: 'q2.mp3', title: 'Second Queued', time: '2026-07-01 11:00', durationSeconds: 240, imported: true, priority: 0 },
      { id: 'r1', status: 'queued', name: 'r1.mp3', title: 'Running Meeting', time: '2026-07-01 09:00', durationSeconds: 300, imported: false, priority: -100 },
    ];
    window.listeners['pipeline:event']?.({ type: 'job_aborted', id: 'r1' });
    await tick();
    check(queuedTitles()[queuedTitles().length - 1].includes('Running Meeting'), 'aborted job did not move to tail: ' + queuedTitles().join(', '));

    // Click Second Queued to open QueuedDetail
    [...document.querySelectorAll('.row-queued .row-hit')].find(b => b.textContent.includes('Second Queued')).click();
    await tick();
    check(document.body.innerText.includes('待处理队列') && button('提前处理'), 'QueuedDetail did not render prioritize button');

    // Prioritize Second Queued
    button('提前处理').click();
    await tick();
    check(window.prioritized.length === 1 && window.prioritized[0] === 'q2', 'prioritizeJob not called for q2');
    check(queuedTitles()[0].includes('Second Queued'), 'q2 did not move to top of queue: ' + queuedTitles().join(', '));
    check(button('已排在下一个')?.disabled, 'prioritized next item should show disabled state');

    // Select Running Meeting (demoted) and test delete confirmation + cancellation + confirmation
    [...document.querySelectorAll('.row-queued .row-hit')].find(b => b.textContent.includes('Running Meeting')).click();
    await tick();
    button('移出队列').click();
    await tick();
    check(window.removed.length === 0 && button('确认移出'), 'confirmation prompt did not appear');
    button('取消').click();
    await tick();
    check(window.removed.length === 0 && !button('确认移出'), 'cancel did not close confirmation');

    button('移出队列').click();
    await tick();
    button('确认移出').click();
    await tick();
    check(window.removed.length === 1 && window.removed[0] === 'r1', 'removeQueuedJob not called for r1');
    check(queuedTitles().length === 1 && !queuedTitles()[0].includes('Running Meeting'), 'r1 was not removed from sidebar');
  })()\`);
  console.log('queue control verified');
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1) });
`)

    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const run = await runAsync(resolve('desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [join(dir, 'main.cjs')], { env, timeoutMs: 20_000 })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('queue control verified')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
