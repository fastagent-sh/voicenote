import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runAsync } from '../../src/testing/fakeModel.ts'

test.skipIf(process.platform !== 'darwin')('primary and selected buttons meet text contrast in both themes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vn-contrast-'))
  try {
    await writeFile(join(dir, 'index.html'), `<!doctype html><link rel="stylesheet" href="${new URL(`file://${resolve('desktop/src/renderer/src/styles.css')}`).href}"><button class="primary">Primary</button><div class="segmented"><button class="on">Selected</button></div>`)
    await writeFile(join(dir, 'main.cjs'), `
const {app, BrowserWindow, nativeTheme} = require('electron');
app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))});
app.whenReady().then(async () => {
 const win = new BrowserWindow({show:false});
 await win.loadFile(${JSON.stringify(join(dir, 'index.html'))});
 for (const theme of ['light','dark']) {
  nativeTheme.themeSource = theme;
  await new Promise(resolve => setTimeout(resolve, 100));
  const ratios = await win.webContents.executeJavaScript(\`(() => {
   const lum = c => {const v=c.match(/[0-9.]+/g).slice(0,3).map(n=>Number(n)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return v[0]*.2126+v[1]*.7152+v[2]*.0722};
   return [...document.querySelectorAll('button')].map(b=>{const s=getComputedStyle(b),a=lum(s.color),z=lum(s.backgroundColor);return (Math.max(a,z)+.05)/(Math.min(a,z)+.05)});
  })()\`);
  if (ratios.some(r => r < 4.5)) throw Error(theme + ' contrast: ' + ratios);
 }
 console.log('contrast verified'); app.exit(0);
}).catch(e => {console.error(e);app.exit(1)});
`)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const run = await runAsync(resolve('desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [join(dir, 'main.cjs')], { env, timeoutMs: 20_000 })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('contrast verified')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
