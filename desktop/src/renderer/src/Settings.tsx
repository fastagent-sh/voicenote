import { useEffect, useState } from 'react'
import { vn, type Status, type UpdateState } from './api.ts'
import { ModelAuthCard } from './ModelAuthCard.tsx'

const FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: 'VOICENOTE_WORKSPACE', label: '笔记存放目录', hint: '留空使用默认目录 (~/Documents/meetings)' },
  { key: 'VOICENOTE_RECORD_DIR', label: '录音笔文件夹', hint: 'Windows 填盘符路径,如 E:\\RECORD' },
  { key: 'VOLCANO_ASR_KEY', label: '火山 ASR 密钥', hint: '转写用,控制台的 API Key' },
  { key: 'VOICENOTE_MAX_AGE_HOURS', label: '处理多久以内的录音(小时)', hint: '0 表示不限' },
  { key: 'LOCAL_PROXY_HOST', label: '代理地址', hint: '仅部分海外服务商需要;火山转写始终直连' },
  { key: 'LOCAL_PROXY_PORT', label: '代理端口' },
]

export function Settings({ status, running = false, onClose, onLogin: _onLogin }: { status: Status | null; running?: boolean; onClose: () => void; onLogin: () => void }) {
  const [env, setEnv] = useState<Record<string, string>>({})
  const [self, setSelf] = useState<{ name: string | null; aliases: string[] }>({ name: null, aliases: [] })
  const [saving, setSaving] = useState(false)
  const [showAsrKey, setShowAsrKey] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateNote, setUpdateNote] = useState<string | null>(null)
  const [pendingApiKey, setPendingApiKey] = useState<{ providerId: string; key: string } | null>(null)

  useEffect(() => {
    void vn.configGet().then(config => {
      setEnv(config.env)
      setSelf(config.self)
    }).catch(error => setMessage(`无法加载设置: ${String(error)}`))
    void vn.updateState().then(state => {
      setUpdate(state)
      if (state.checking) setCheckingUpdate(true)
    }).catch(error => setMessage(String(error)))
    const off = [
      vn.on('update:available', (ver: string) => {
        setCheckingUpdate(false)
        setUpdateNote(null)
        setUpdate(u => ({ version: u?.version ?? '', ready: u?.ready ?? null, manual: Boolean(u?.manual), ...u, available: ver }))
      }),
      vn.on('update:not-available', () => {
        setCheckingUpdate(false)
        setUpdateNote('当前已是最新版本')
        setUpdate(u => (u ? { ...u, available: null, checking: false } : u))
      }),
      vn.on('update:ready', (ver: string) => {
        setCheckingUpdate(false)
        setUpdateNote(null)
        setUpdate(u => ({ version: u?.version ?? '', manual: Boolean(u?.manual), ...u, available: ver, ready: ver }))
      }),
      vn.on('update:manual', (ver: string) => {
        setCheckingUpdate(false)
        setUpdate(u => ({ version: u?.version ?? '', ...u, available: ver, ready: ver, manual: true }))
      }),
      vn.on('update:error', (err: string) => {
        setCheckingUpdate(false)
        setUpdateNote(`检查更新失败：${err}`)
      }),
    ]
    return () => { off.forEach(fn => fn()) }
  }, [])

  const checkUpdates = async () => {
    if (checkingUpdate) return
    setCheckingUpdate(true)
    setUpdateNote(null)
    try {
      const next = await vn.checkForUpdates()
      setUpdate(next)
      if (next.packaged === false) setUpdateNote('开发模式不检查安装包更新，可点「查看发布页」查看')
      else if (next.error) setUpdateNote(`检查更新失败：${next.error}`)
      else if (!next.ready && !next.available) setUpdateNote('当前已是最新版本')
    } catch (error) {
      setUpdateNote(`检查更新失败：${String((error as Error)?.message ?? error)}`)
    } finally {
      setCheckingUpdate(false)
    }
  }

  const installUpdate = async () => {
    try {
      const { installable } = await vn.installUpdate()
      if (!installable) setUpdateNote('已打开下载页，手动安装一次即可')
    } catch (error) {
      setUpdateNote(`更新失败：${String((error as Error)?.message ?? error)}`)
    }
  }

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
            <div key={field.key}>
              <label>
                <span>{field.label}</span>
                <input
                  type={field.key === 'VOLCANO_ASR_KEY' && !showAsrKey ? 'password' : 'text'}
                  value={env[field.key] ?? ''}
                  placeholder={field.hint ?? ''}
                  onChange={e => setEnv({ ...env, [field.key]: e.target.value })}
                />
              </label>
              {field.key === 'VOLCANO_ASR_KEY' && <button type="button" onClick={() => setShowAsrKey(show => !show)}>{showAsrKey ? '隐藏密钥' : '显示密钥'}</button>}
            </div>
          ))}
        </section>

        <section>
          <h3>关于</h3>
          <div className="sheet-row">
            <span className="hint">VoiceNote {update?.version || ''}{status?.pi.version ? ` · 纪要引擎 pi ${status.pi.version}` : ''}</span>
            <div className="row-actions">
              {update?.ready
                ? (
                  <button className="primary" disabled={running && !update.manual} onClick={() => void installUpdate()}>
                    {update.manual ? '打开下载页' : '重启以更新'}
                  </button>
                )
                : (
                  <button onClick={() => void checkUpdates()} disabled={checkingUpdate || Boolean(update?.available)}>
                    {checkingUpdate ? '检查中…' : update?.available ? '下载中…' : '检查更新'}
                  </button>
                )}
              <button onClick={() => void vn.openReleases()}>查看发布页</button>
            </div>
          </div>
          {update?.ready && (
            <p className="hint fine">
              {update.manual
                ? `发现新版本 ${update.ready}，无法自动安装，需要手动下载一次。`
                : `新版本 ${update.ready} 已下载${running ? '，当前处理完成后可重启更新' : '，点击「重启以更新」即可完成安装'}。`}
            </p>
          )}
          {!update?.ready && update?.available && (
            <p className="hint fine">发现新版本 {update.available}，正在后台下载…</p>
          )}
          {!update?.ready && !update?.available && updateNote && (
            <p className="hint fine">{updateNote}</p>
          )}
        </section>

        {message && <p className="hint">{message}</p>}
      </main>
    </div>
  )
}
