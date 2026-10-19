import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runAsync } from '../../src/testing/fakeModel.ts'

// A recording the pipeline set aside stays reachable by hand: the row keeps its
// button and clicking it runs that file. An explicit ignore is the only verdict
// without one. Rendered in a real Electron window against a fake preload bridge,
// so nothing on disk or in the real config is touched.
test.skipIf(process.platform !== 'darwin')('a set-aside recording keeps its reprocess button', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vn-recorder-ui-'))
  const renderer = resolve('desktop/src/renderer/src/Recorder.tsx')
  const react = resolve('desktop/node_modules/react/index.js')
  const reactDom = resolve('desktop/node_modules/react-dom/client.js')
  try {
    const entry = join(dir, 'entry.ts')
    await writeFile(entry, `
import { createElement } from ${JSON.stringify(react)}
import { createRoot } from ${JSON.stringify(reactDom)}
import { Recorder } from ${JSON.stringify(renderer)}
createRoot(document.getElementById('root')!).render(createElement(Recorder, {
  running: false,
  onClose() { window.closed = true },
  onToast() {},
}))
`)
    const build = await Bun.build({ entrypoints: [entry], outdir: dir, target: 'browser', naming: 'renderer.js' })
    expect(build.success, String(build.logs)).toBe(true)
    const row = (patch: Record<string, unknown>) => ({
      name: '20261019164558.mp3', path: '/rec/bad.mp3', recordedAt: '2026-10-19T16:45:58',
      sizeBytes: 3_000_000, durationSeconds: 840, detail: null, state: 'filtered', title: null, ...patch,
    })
    const items = [
      row({ sourceId: 'bad', verdict: 'bad_audio', detail: 'Volcano: 45000151 audio format not supported' }),
      row({ sourceId: 'small', verdict: 'too_small', name: '20261019170635.mp3', path: '/rec/small.mp3', state: null, sizeBytes: 81_000, durationSeconds: 20 }),
      row({ sourceId: 'ignored', verdict: 'ignored', name: '20260922123420.mp3', path: '/rec/ignored.mp3' }),
    ]
    await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><div id="root"></div><script>
window.ran = []; window.closed = false;
window.vn = {
  recorderFiles: async () => ({ dir: '/rec', present: true, items: ${JSON.stringify(items)} }),
  runFile: async path => { window.ran.push(path); return { queued: false } },
};
</script><script src="renderer.js"></script>`)
    await writeFile(join(dir, 'main.cjs'), `
const {app, BrowserWindow} = require('electron');
app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
app.whenReady().then(async () => {
 const win = new BrowserWindow({show:false});
 win.webContents.on('console-message', event => console.error(event.message));
 await win.loadFile(${JSON.stringify(join(dir, 'index.html'))});
 await win.webContents.executeJavaScript(\`(async () => {
 const check = (ok, message) => {if (!ok) throw new Error(message)};
 const tick = () => new Promise(resolve => setTimeout(resolve, 30));
 const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
 const rows = () => [...document.querySelectorAll('.file-row')];
 const rowWith = label => rows().find(r => r.textContent.includes(label));
 for(let i=0;i<50 && !button('刷新');i++) await tick();
 check(!rows().length, 'skipped recordings must start folded away');
 const unfold = [...document.querySelectorAll('button')].find(b => b.textContent.includes('另有 3 个'));
 check(unfold, 'folded recordings offer no way to open them');
 unfold.click(); await tick();
 check(rows().length === 3, 'expected every recording to be listed');
 const reprocess = rowWith('音频无法识别').querySelector('button');
 check(reprocess && reprocess.textContent.trim() === '重新处理', 'a recording set aside as unusable audio cannot be reprocessed');
 check(rowWith('文件太小').querySelector('button').textContent.trim() === '处理', 'an untouched file should be processed, not reprocessed');
 check(!rowWith('已忽略').querySelector('button'), 'an ignored recording must not offer a button');
 reprocess.click(); await tick();
 check(window.ran.length === 1 && window.ran[0] === '/rec/bad.mp3', 'clicking reprocess did not run that file');
})()\`);
 console.log('recorder verified'); app.exit(0);
}).catch(error => {console.error(error); app.exit(1)});
`)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const run = await runAsync(resolve('desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [join(dir, 'main.cjs')], { env, timeoutMs: 20_000 })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('recorder verified')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
