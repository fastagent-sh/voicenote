import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runAsync } from '../../src/testing/fakeModel.ts'

test.skipIf(process.platform !== 'darwin')('existing users stay on the main screen and search refreshes after notes change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vn-app-recovery-'))
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
window.listeners = {}; window.searches = 0; window.auth = false;
window.vn = {
 status: async () => ({recorder:{exists:false},volcano:{configured:true},pi:{available:true,auth:window.auth},summary:{model:'test'}}),
 jobs: async () => ({items:[{id:'one',status:'done',name:'old.mp3',title:'Old note',time:'2020-01-01',notes:'/tmp/old.md'}]}),
 pendingRetries: async () => [], updateState: async () => ({}),
 search: async () => {window.searches++; return []}, readNote: async () => '# Old note',
 on: (key, fn) => {window.listeners[key] = fn; return () => {}},
};
</script><script src="renderer.js"></script>`)
    await writeFile(join(dir, 'main.cjs'), `
const {app, BrowserWindow} = require('electron');
app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
app.whenReady().then(async () => {
 const win = new BrowserWindow({show:false});
 await win.loadFile(${JSON.stringify(join(dir, 'index.html'))});
 await win.webContents.executeJavaScript(\`(async () => {
  const check = (ok, why) => { if (!ok) throw Error(why) };
  const tick = () => new Promise(r => setTimeout(r, 40));
  for (let i=0;i<50 && !document.body.innerText.includes('纪要模型尚未配置认证');i++) await tick();
  check(document.querySelector('.search input'), 'existing user was sent to onboarding');
  check(document.body.innerText.includes('纪要模型尚未配置认证'), 'missing auth was not shown: ' + document.body.innerText);
  const input = document.querySelector('.search input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input, 'meeting');
  input.dispatchEvent(new Event('input',{bubbles:true}));
  for (let i=0;i<30 && window.searches<1;i++) await tick();
  check(window.searches === 1, 'initial search did not run');
  window.listeners['pipeline:event']({type:'job_done',id:'one',stub:false,title:'Old note'});
  for (let i=0;i<30 && window.searches<2;i++) await tick();
  check(window.searches >= 2, 'search was not refreshed after output changed');
 })()\`);
 console.log('app recovery verified'); app.exit(0);
}).catch(e => {console.error(e);app.exit(1)});
`)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const run = await runAsync(resolve('desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [join(dir, 'main.cjs')], { env, timeoutMs: 20_000 })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('app recovery verified')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
