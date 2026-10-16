import { useEffect, useState } from 'react'
import { vn, type Status } from './api.ts'
import { ModelAuthCard } from './ModelAuthCard.tsx'

/**
 * Shown until the app can actually do its job: sign in, a transcription key,
 * and somewhere to put the notes. Each step reports its own state, so a
 * half-finished setup is obvious instead of failing later on a real recording.
 */
const isWindows = navigator.userAgent.includes('Windows')

export function Onboarding({ status, onDone, onRefresh }: {
  status: Status | null
  onDone: () => void
  onRefresh: () => void
}) {
  const [model, setModel] = useState('')
  const [asrKey, setAsrKey] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [recordDir, setRecordDir] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingApiKey, setPendingApiKey] = useState<{ providerId: string; key: string } | null>(null)

  useEffect(() => {
    void vn.configGet().then(config => {
      setModel(config.env.VOICENOTE_PI_MODEL ?? '')
      setAsrKey(config.env.VOLCANO_ASR_KEY ?? '')
      setWorkspace(config.env.VOICENOTE_WORKSPACE ?? '')
      setRecordDir(config.env.VOICENOTE_RECORD_DIR ?? '')
    })
  }, [])

  const hasAuth = !!status?.pi.auth || Boolean(pendingApiKey?.key)
  const hasKey = asrKey.trim().length > 0

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      if (pendingApiKey?.key) {
        await vn.piSetApiKey(pendingApiKey.providerId, pendingApiKey.key)
      }
      await vn.configSet({
        env: {
          VOLCANO_ASR_KEY: asrKey.trim(),
          VOICENOTE_WORKSPACE: workspace.trim(),
          VOICENOTE_RECORD_DIR: recordDir.trim(),
          ...(model ? { VOICENOTE_PI_MODEL: model } : {}),
        },
      })
      onRefresh()
      onDone()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="app">
      <header className="titlebar"><div className="brand">欢迎使用 VoiceNote</div></header>
      <main className="sheet onboarding">
        <p className="hint">三步就能开始：把录音变成可读的纪要。</p>

        <section>
          <h3><span className={hasAuth ? 'step-dot done' : 'step-dot'}>1</span> 配置纪要模型 (ChatGPT / DeepSeek 等)</h3>
          <p className="hint">纪要由 AI 模型生成。支持 ChatGPT 账号授权登录，或配置 DeepSeek 等模型的 API Key。</p>
          <ModelAuthCard
            currentModel={model}
            onModelChange={m => setModel(m)}
            onStatusChange={onRefresh}
            onPendingKeyChange={(providerId, key) => setPendingApiKey(key ? { providerId, key } : null)}
          />
        </section>

        <section>
          <h3><span className={hasKey ? 'step-dot done' : 'step-dot'}>2</span> 填写转写密钥</h3>
          <p className="hint">语音转文字用火山引擎豆包，在控制台复制 API Key 粘贴到这里。</p>
          <input type="text" value={asrKey} placeholder="火山 ASR API Key" onChange={e => setAsrKey(e.target.value)} />
        </section>

        <section>
          <h3><span className={recordDir ? 'step-dot done' : 'step-dot'}>3</span> 录音笔位置</h3>
          <p className="hint">
            {isWindows
              ? '插上录音笔后它是一个盘符,比如 E:\\RECORD。填录音文件所在的文件夹。'
              : '默认是 /Volumes/VTR6500/RECORD。用别的录音笔就改成它挂载后的录音文件夹。'}
          </p>
          <div className="sheet-row">
            <span className="path">{recordDir || (isWindows ? '（未设置,Windows 必填）' : '（默认：/Volumes/VTR6500/RECORD）')}</span>
            <button onClick={async () => { const dir = await vn.pickDirectory(); if (dir) setRecordDir(dir) }}>选择文件夹…</button>
          </div>
        </section>

        <section>
          <h3><span className={workspace ? 'step-dot done' : 'step-dot'}>4</span> 选择笔记目录</h3>
          <p className="hint">纪要、转写稿和音频都会存在这里。留空则用默认目录。</p>
          <div className="sheet-row">
            <span className="path">{workspace || '（默认：~/Documents/meetings）'}</span>
            <button onClick={async () => { const dir = await vn.pickDirectory(); if (dir) setWorkspace(dir) }}>选择目录…</button>
          </div>
        </section>

        {error && <p className="problem">{error}</p>}
        <div className="sheet-row">
          <button className="link" onClick={onDone}>稍后再说</button>
          <button className="primary" onClick={() => void save()} disabled={saving || !hasAuth || !hasKey}>开始使用</button>
        </div>
      </main>
    </div>
  )
}
