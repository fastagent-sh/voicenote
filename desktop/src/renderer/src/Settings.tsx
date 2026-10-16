import { useEffect, useState } from 'react'
import { vn, type Status } from './api.ts'
import { ModelAuthCard } from './ModelAuthCard.tsx'

const FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: 'VOICENOTE_WORKSPACE', label: '笔记存放目录', hint: '留空使用默认目录 (~/Documents/meetings)' },
  { key: 'VOICENOTE_RECORD_DIR', label: '录音笔文件夹', hint: 'Windows 填盘符路径,如 E:\\RECORD' },
  { key: 'VOLCANO_ASR_KEY', label: '火山 ASR 密钥', hint: '转写用,控制台的 API Key' },
  { key: 'VOICENOTE_MAX_AGE_HOURS', label: '处理多久以内的录音(小时)', hint: '0 表示不限' },
  { key: 'LOCAL_PROXY_HOST', label: '代理地址', hint: '仅部分海外服务商需要;火山转写始终直连' },
  { key: 'LOCAL_PROXY_PORT', label: '代理端口' },
]

export function Settings({ status, onClose, onLogin: _onLogin }: { status: Status | null; onClose: () => void; onLogin: () => void }) {
  const [env, setEnv] = useState<Record<string, string>>({})
  const [self, setSelf] = useState<{ name: string | null; aliases: string[] }>({ name: null, aliases: [] })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [version, setVersion] = useState('')
  const [pendingApiKey, setPendingApiKey] = useState<{ providerId: string; key: string } | null>(null)

  useEffect(() => {
    void vn.configGet().then(config => {
      setEnv(config.env)
      setSelf(config.self)
    }).catch(error => setMessage(`无法加载设置: ${String(error)}`))
    void vn.updateState().then(state => setVersion(state.version)).catch(error => setMessage(String(error)))
  }, [])

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      if (pendingApiKey?.key) {
        await vn.piSetApiKey(pendingApiKey.providerId, pendingApiKey.key)
      }
      await vn.configSet({ env, self: { name: self.name, aliases: self.aliases } })
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
        <button onClick={onClose} disabled={saving}>返回</button>
        <button className="primary" onClick={() => void save()} disabled={saving}>保存</button>
      </header>

      <main className="sheet">
        <section>
          <h3>纪要模型</h3>
          <p className="hint">选择用于将转写稿提炼为会议纪要的 AI 模型与对应授权。</p>
          <ModelAuthCard
            currentModel={env.VOICENOTE_PI_MODEL ?? ''}
            onModelChange={model => setEnv({ ...env, VOICENOTE_PI_MODEL: model })}
            onAuthRemoved={async (_providerId, envKeys) => {
              const config = await vn.configGet()
              setEnv(current => {
                const next = { ...current }
                for (const key of envKeys) {
                  if (Object.hasOwn(config.env, key)) next[key] = config.env[key]!
                  else delete next[key]
                }
                return next
              })
            }}
            onPendingKeyChange={(providerId, key) => setPendingApiKey(key ? { providerId, key } : null)}
            disabled={saving}
          />
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
          <h3>处理设置</h3>
          {FIELDS.map(field => (
            <label key={field.key}>
              <span>{field.label}</span>
              <input
                type="text"
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
        </section>

        {message && <p className="hint">{message}</p>}
      </main>
    </div>
  )
}
