import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runAsync } from '../../src/testing/fakeModel.ts'

// Uses a separate Electron profile and a fake preload bridge; no real settings or credentials are read.
test.skipIf(process.platform !== 'darwin')('settings discard cancelled keys and keep custom model editing stable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vn-settings-ui-'))
  const renderer = resolve('desktop/src/renderer/src/Settings.tsx')
  const react = resolve('desktop/node_modules/react/index.js')
  const reactDom = resolve('desktop/node_modules/react-dom/client.js')
  try {
    const entry = join(dir, 'entry.ts')
    await writeFile(entry, `
import { createElement } from ${JSON.stringify(react)}
import { createRoot } from ${JSON.stringify(reactDom)}
import { Settings } from ${JSON.stringify(renderer)}
createRoot(document.getElementById('root')!).render(createElement(Settings, {status: null, onClose() {}, onLogin() {}}))
`)
    const build = await Bun.build({ entrypoints: [entry], outdir: dir, target: 'browser', naming: 'renderer.js' })
    expect(build.success, String(build.logs)).toBe(true)
    await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><div id="root"></div><script>
window.savedKeys = []; window.savedConfigs = [];
window.vn = {
 configGet: async () => ({env: {VOICENOTE_PI_MODEL:'deepseek/deepseek-flash'}, self:{name:null,aliases:[]}}),
 updateState: async () => ({version:'test'}),
 piProviders: async () => [
 {id:'deepseek',name:'DeepSeek',configured:true,authType:'api_key',source:'stored',hasApiKey:true,hasOAuth:false,envKeys:['DEEPSEEK_API_KEY','DEEPSEEK_KEY'],defaultModelId:'deepseek-flash',apiKey:'original-key',models:[{id:'deepseek-flash',name:'Flash'}]},
 {id:'kimi-coding',name:'Kimi',configured:false,hasApiKey:true,hasOAuth:false,envKeys:['KIMI_API_KEY'],defaultModelId:'kimi-for-coding',models:[{id:'kimi-for-coding',name:'Kimi model'}]},
 {id:'minimax',name:'MiniMax',configured:false,hasApiKey:true,hasOAuth:false,envKeys:['MINIMAX_API_KEY'],defaultModelId:'MiniMax-M2.7',models:[{id:'MiniMax-M2.7',name:'MiniMax M2.7'}]}
 ],
 piRemoveAuth: async () => {},
 on: () => () => {},
 piSetApiKey: async (...args) => window.savedKeys.push(args),
 configSet: async config => window.savedConfigs.push(config)
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
 const change = (el, value) => {
   Object.getOwnPropertyDescriptor(el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, value);
   el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true}));
 };
 for(let i=0;i<50 && !button('修改 Key');i++) await tick();
 check(button('修改 Key'), 'settings did not load');
 button('修改 Key').click(); await tick();
 change([...document.querySelectorAll('input')].find(e => e.placeholder.includes('API Key')), 'cancelled-key'); await tick();
 button('取消').click(); await tick();
 document.querySelector('header button.primary').click(); await tick();
 check(window.savedKeys.length === 0, 'cancelled key was persisted');
 check(window.savedConfigs.length === 1, 'settings were not saved');
 const asr = [...document.querySelectorAll('label')].find(e => e.textContent.includes('火山 ASR 密钥')).querySelector('input');
 change(asr, 'unsaved-asr-key'); await tick();
 button('清除').click(); await tick(); await tick();
 check(asr.value === 'unsaved-asr-key', 'clearing provider erased unsaved ASR key');
 document.querySelector('header button.primary').click(); await tick();
 check(window.savedConfigs.at(-1).env.VOLCANO_ASR_KEY === 'unsaved-asr-key', 'ASR key lost on save');
 change(document.querySelector('select'), 'kimi-coding'); await tick();
 check(!button('授权登录') && !button('OAuth 登录'), 'Kimi must not offer device-only OAuth');
 const kimiInput = [...document.querySelectorAll('input')].find(e => e.placeholder.includes('Kimi API Key'));
 check(kimiInput, 'Kimi API key input not found');
 change(kimiInput, 'my-unclicked-kimi-key'); await tick();
 document.querySelector('header button.primary').click(); await tick();
 check(window.savedKeys.some(k => k[0] === 'kimi-coding' && k[1] === 'my-unclicked-kimi-key'), 'pending API key was not saved on main save');
 change(document.querySelector('select'), 'minimax'); await tick();
 const modelSelect = document.querySelectorAll('select')[1];
 check(modelSelect.value === 'minimax/MiniMax-M2.7', 'default model did not come from runtime');
 check(modelSelect.options.length === 2 && modelSelect.options[0].value === '', 'static models leaked into runtime catalog');
 change(modelSelect, ''); await tick();
 check(modelSelect.value === '', 'unable to select default engine model');
 check(document.querySelector('select').value === 'minimax', 'selecting default model changed provider unexpectedly');
 change(document.querySelector('select'), 'custom'); await tick();
 check(!button('授权登录') && [...document.querySelectorAll('input')].some(e => e.placeholder.includes('API Key')), 'custom model must show API key input, not OAuth');
 let input = [...document.querySelectorAll('input')].find(e => e.placeholder.includes('ollama'));
 check(input, 'manual model input missing');
 change(input, ''); await tick();
 check(document.contains(input), 'clearing input exited manual mode');
 for(const value of ['o','openai','openai/','openai/my-model']) {
   change(input, value); await tick();
   check(document.contains(input), 'typing provider exited manual mode');
 }
 document.querySelector('header button.primary').click(); await tick();
 check(window.savedConfigs.at(-1).env.VOICENOTE_PI_MODEL === 'openai/my-model', 'custom model not saved');
})()\`);
 console.log('settings verified'); app.exit(0);
}).catch(error => {console.error(error); app.exit(1)});
`)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const run = await runAsync(resolve('desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [join(dir, 'main.cjs')], { env, timeoutMs: 20_000 })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('settings verified')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
