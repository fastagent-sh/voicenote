import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runAsync } from '../../src/testing/fakeModel.ts'

test.skipIf(process.platform !== 'darwin')('regeneration requires confirmation and can be cancelled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vn-regenerate-ui-'))
  try {
    await writeFile(join(dir, 'entry.ts'), `
import { createElement } from ${JSON.stringify(resolve('desktop/node_modules/react/index.js'))}
import { createRoot } from ${JSON.stringify(resolve('desktop/node_modules/react-dom/client.js'))}
import { NoteDetail } from ${JSON.stringify(resolve('desktop/src/renderer/src/NoteDetail.tsx'))}
createRoot(document.getElementById('root')!).render(createElement(NoteDetail, {
 job:{notes:'/tmp/note.md',title:'Note',name:'note.mp3'}, pending:false,
 onRegenerate(){ window.regenerations++ }, onToast() {},
}))
`)
    const build = await Bun.build({ entrypoints: [join(dir, 'entry.ts')], outdir: dir, target: 'browser', naming: 'renderer.js' })
    expect(build.success, String(build.logs)).toBe(true)
    await writeFile(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script>window.regenerations=0;window.vn={readNote:async()=>"# Note\\n\\nBody"}</script><script src="renderer.js"></script>')
    await writeFile(join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(dir, 'profile'))});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false}); await win.loadFile(${JSON.stringify(join(dir, 'index.html'))});
 await win.webContents.executeJavaScript(\`(async()=>{
  const tick=()=>new Promise(r=>setTimeout(r,40));
  const button=t=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);
  const check=(v,m)=>{if(!v)throw Error(m)};
  for(let i=0;i<30&&!button('重新生成');i++)await tick();
  button('重新生成').click(); await tick();
  check(window.regenerations===0 && document.body.innerText.includes('手动修改'), 'warning missing or regeneration started early');
  button('取消').click(); await tick();
  check(window.regenerations===0 && !button('确认重新生成'), 'cancel did not dismiss');
  button('重新生成').click(); await tick(); button('确认重新生成').click(); await tick();
  check(window.regenerations===1, 'confirmation did not start regeneration');
 })()\`);
 console.log('confirmation verified'); app.exit(0);
}).catch(e=>{console.error(e);app.exit(1)});
`)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const run = await runAsync(resolve('desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [join(dir, 'main.cjs')], { env, timeoutMs: 20_000 })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('confirmation verified')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
