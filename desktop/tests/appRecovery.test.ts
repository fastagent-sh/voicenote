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
 search: async () => {window.searches++; return []}, readNote: async () => '# Old note\\n\\n**Decision**\\n\\n<!-- voicenote:source -->\\n/Users/private/audio.mp3',
 pickAudio: async () => [], pathForFile: f => f.name,
 importRecordings: async paths => { window.imported = paths; return paths.map(path => {
   if (path === 'bad.txt') return {status:'failed', path, error:'unsupported audio'};
   if (path === 'old.mp3') return {status:'already_done',id:'one',title:'Old note',notes:'/tmp/old.md'};
   return {status:'queued',id:path,name:path};
 }) },
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
  const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
  button('导入').click(); await tick();
  check(!window.imported && !document.querySelector('.toast'), 'cancel reported an import');
  const transfer = new DataTransfer();
  for (const name of ['new.mp3','bad.txt','old.mp3']) transfer.items.add(new File(['x'],name));
  document.querySelector('.shell').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true})); await tick();
  check(window.imported.join(',') === 'new.mp3,bad.txt,old.mp3', 'drop lost files');
  check(document.body.innerText.includes('1 条已加入队列') && document.body.innerText.includes('1 条已有纪要') && document.body.innerText.includes('unsupported audio'), 'mixed result not shown');
  button('重试导入').click(); await tick();
  check(window.imported.join(',') === 'bad.txt' && button('打开纪要：Old note'), 'retry lost the successful results');
  window.vn.pickAudio = async () => ['old.mp3','new.mp3'];
  button('导入').click(); await tick();
  check(window.imported.join(',') === 'old.mp3,new.mp3', 'picker lost files');
  button('打开纪要：Old note').click(); await tick();
  Object.defineProperty(navigator, 'clipboard', {value:{writeText:async text => {window.copied=text}}});
  button('复制').click(); await tick();
  check(window.copied === '# Old note' + String.fromCharCode(10,10) + '**Decision**', 'clipboard lost formatting or exposed paths');
  navigator.clipboard.writeText = async () => {throw Error('denied')};
  button('复制').click(); await tick();
  check(document.querySelector('.toast')?.textContent.includes('复制失败：denied'), 'clipboard failure reported success');
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
