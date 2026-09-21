import { useEffect, useState } from 'react'
import { vn, type Status } from './api.ts'

/** Everything the app needs to work, on one sheet. */
const FIELDS: { key: string; label: string; hint?: string; secret?: boolean }[] = [
  { key: 'VOICENOTE_WORKSPACE', label: '笔记存放目录', hint: '留空使用默认目录' },
  { key: 'VOICENOTE_RECORD_DIR', label: '录音笔文件夹', hint: 'Windows 填盘符路径,如 E:\\RECORD' },
  { key: 'VOLCANO_ASR_KEY', label: '火山 ASR 密钥', hint: '转写用,控制台的 API Key', secret: true },
  { key: 'VOICENOTE_MAX_AGE_HOURS', label: '处理多久以内的录音(小时)', hint: '0 表示不限' },
  { key: 'VOICENOTE_PI_MODEL', label: '纪要模型', hint: '例如 openai-codex/gpt-5.6-sol,留空用 pi 的默认模型' },
  { key: 'LOCAL_PROXY_HOST', label: '代理地址', hint: '仅 ChatGPT 需要;火山转写始终直连' },
  { key: 'LOCAL_PROXY_PORT', label: '代理端口' },
]

export function Settings({ status, onClose, onLogin }: { status: Status | null; onClose: () => void; onLogin: () => void }) {
  const [env, setEnv] = useState<Record<string, string>>({})
  const [self, setSelf] = useState<{ name: string | null; aliases: string[] }>({ name: null, aliases: [] })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void vn.configGet().then(config => { setEnv(config.env); setSelf(config.self) })
    void vn.updateState().then(state => setVersion(state.version))
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      await vn.configSet({ env, self: { name: self.name, aliases: self.aliases } })
      setMessage('已保存')
      onClose()
    } catch (error) {
      setMessage(String((error as Error).message ?? error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">设置</div>
        <div className="grow" />
        <button onClick={onClose}>返回</button>
        <button className="primary" onClick={() => void save()} disabled={saving}>保存</button>
      </header>

      <main className="sheet">
        <section>
          <h3>ChatGPT</h3>
          <div className="sheet-row">
            <span>{status?.pi.auth ? '已登录' : '未登录'}{status?.pi.version ? ` · pi ${status.pi.version}` : ''}</span>
            <button onClick={onLogin}>{status?.pi.auth ? '重新登录' : '登录'}</button>
          </div>
        </section>

        <section>
          <h3>我是谁</h3>
          <p className="hint">用于把转写里的 Speaker A/B/C 对上真名。</p>
          <label>
            <span>姓名</span>
            <input value={self.name ?? ''} onChange={e => setSelf({ ...self, name: e.target.value })} />
          </label>
          <label>
            <span>别名</span>
            <input
              value={self.aliases.join(', ')}
              placeholder="逗号分隔"
              onChange={e => setSelf({ ...self, aliases: e.target.value.split(',').map(a => a.trim()).filter(Boolean) })}
            />
          </label>
        </section>

        <section>
          <h3>处理</h3>
          {FIELDS.map(field => (
            <label key={field.key}>
              <span>{field.label}</span>
              <input
                type={field.secret ? 'password' : 'text'}
                value={env[field.key] ?? ''}
                placeholder={field.hint ?? ''}
                onChange={e => setEnv({ ...env, [field.key]: e.target.value })}
              />
            </label>
          ))}
        </section>

        <section>
          <h3>关于</h3>
          <div className="sheet-row">
            <span className="hint">VoiceNote {version || ''}{status?.pi.version ? ` · 纪要引擎 pi ${status.pi.version}` : ''}</span>
            <button onClick={() => void vn.openReleases()}>查看发布页</button>
          </div>
          <p className="hint">新版本会在后台自动下载,下载完成后窗口顶部会提示重启。</p>
        </section>

        {message && <p className="hint">{message}</p>}
      </main>
    </div>
  )
}
