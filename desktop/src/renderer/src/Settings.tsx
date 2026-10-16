import { useEffect, useState } from 'react'
import { vn, type LoginEvent, type ProviderInfo, type Status } from './api.ts'

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

  const [providerStatuses, setProviderStatuses] = useState<ProviderInfo[]>([])
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [editingKey, setEditingKey] = useState(false)
  const [manualModel, setManualModel] = useState(false)
  const [selectedProviderId, setSelectedProviderId] = useState<string>('openai-codex')
  const [keySaving, setKeySaving] = useState(false)

  const [authMethodChoice, setAuthMethodChoice] = useState<'oauth' | 'api_key'>('oauth')
  const [oauthPending, setOauthPending] = useState(false)
  const [oauthStatusText, setOauthStatusText] = useState<string | null>(null)
  const [oauthError, setOauthError] = useState<string | null>(null)
  const [loginPrompt, setLoginPrompt] = useState<Extract<LoginEvent, { event: 'prompt' }> | null>(null)
  const [loginAnswer, setLoginAnswer] = useState('')

  const loadProviderStatuses = async () => {
    try {
      const list = await vn.piProviders()
      setProviderStatuses(list)
    } catch (error) {
      setMessage(`无法加载认证状态: ${String(error)}`)
    }
  }

  useEffect(() => {
    void Promise.all([vn.configGet(), vn.piProviders()]).then(([config, providers]) => {
      setEnv(config.env)
      setSelf(config.self)
      setProviderStatuses(providers)
      const model = config.env.VOICENOTE_PI_MODEL ?? ''
      if (model) {
        const prov = model.split('/')[0]
        if (prov) setSelectedProviderId(prov)
      }
      setManualModel(Boolean(model) && !providers.some(p => p.models.some(m => `${p.id}/${m.id}` === model)))
    }).catch(error => setMessage(`无法加载设置: ${String(error)}`))
    void vn.updateState().then(state => setVersion(state.version)).catch(error => setMessage(String(error)))

    return vn.on('login:event', (event: LoginEvent) => {
      if (event.event === 'auth_url') {
        setOauthStatusText('已打开浏览器，请在网页中完成授权…')
        setOauthError(null)
      }
      if (event.event === 'prompt') {
        setLoginPrompt(event)
        setLoginAnswer(event.prompt.type === 'select' ? event.prompt.options[0]?.id ?? '' : '')
      }
      if (event.event === 'prompt_closed') {
        setLoginPrompt(current => current?.id === event.id ? null : current)
      }
      if (event.event === 'progress') {
        setOauthStatusText(event.message)
      }
      if (event.event === 'success') {
        setOauthStatusText('登录成功！')
        setOauthPending(false)
        void loadProviderStatuses()
      }
      if (event.event === 'error') {
        setOauthError(`登录失败: ${event.message}`)
        setOauthStatusText(null)
        setOauthPending(false)
      }
    })
  }, [])

  const currentModel = env.VOICENOTE_PI_MODEL ?? ''
  const isCustomProvider = manualModel
  const currentProviderId = isCustomProvider
    ? (currentModel.split('/')[0] || selectedProviderId)
    : (currentModel ? currentModel.split('/')[0] || selectedProviderId : selectedProviderId)
  const currentStatus = providerStatuses.find(p => p.id === currentProviderId)
  const isConfigured = currentStatus?.configured ?? false
  const currentProviderMeta = currentStatus ?? {
    name: currentProviderId, hasApiKey: false, hasOAuth: false,
  }
  const availableModels = (currentStatus?.models ?? []).map(m => ({
    id: `${currentProviderId}/${m.id}`,
    label: m.name,
  }))

  useEffect(() => {
    if (currentStatus?.authType === 'api_key' || (currentProviderMeta.hasApiKey && !currentProviderMeta.hasOAuth)) {
      setAuthMethodChoice('api_key')
    } else if (isConfigured && currentProviderMeta.hasOAuth) {
      setAuthMethodChoice('oauth')
    }
  }, [currentProviderId, currentStatus?.configured, currentStatus?.authType])

  const handleProviderChange = (newProviderId: string) => {
    setEditingKey(false)
    setApiKeyInput('')
    setManualModel(newProviderId === 'custom')
    if (newProviderId === 'custom') {
      setAuthMethodChoice('api_key')
      return
    }
    setSelectedProviderId(newProviderId)
    const targetStatus = providerStatuses.find(p => p.id === newProviderId)
    if (!targetStatus?.defaultModelId) {
      setMessage('该服务商暂无可选纪要模型，请先在 models.json 中配置。')
      return
    }
    setEnv({ ...env, VOICENOTE_PI_MODEL: `${newProviderId}/${targetStatus.defaultModelId}` })
    if (targetStatus.authType === 'api_key' || !targetStatus.hasOAuth) {
      setAuthMethodChoice('api_key')
    } else {
      setAuthMethodChoice('oauth')
    }
  }

  const handleModelChange = (newModelId: string) => {
    setEnv({ ...env, VOICENOTE_PI_MODEL: newModelId })
  }

  const handleSaveKey = async () => {
    if (!apiKeyInput.trim()) return
    setKeySaving(true)
    try {
      await vn.piSetApiKey(currentProviderId, apiKeyInput.trim())
      await vn.configSet({ env, self: { name: self.name, aliases: self.aliases } })
      setEditingKey(false)
      setApiKeyInput('')
      await loadProviderStatuses()
    } catch (e: any) {
      setMessage(`保存 API Key 失败: ${e.message}`)
    } finally {
      setKeySaving(false)
    }
  }

  const handleRemoveAuth = async (targetProviderId = currentProviderId) => {
    try {
      await vn.piRemoveAuth(targetProviderId)
    } catch (e: any) {
      setMessage(`清除凭据: ${e.message}`)
    }
    try {
      const config = await vn.configGet()
      const keys = providerStatuses.find(p => p.id === targetProviderId)?.envKeys ?? []
      setEnv(current => {
        const next = { ...current }
        for (const key of keys) {
          if (Object.hasOwn(config.env, key)) next[key] = config.env[key]!
          else delete next[key]
        }
        return next
      })
      setApiKeyInput('')
      setEditingKey(false)
      await loadProviderStatuses()
    } catch (error) {
      setMessage(`无法刷新设置: ${String(error)}`)
    }
  }

  const submitLoginAnswer = async () => {
    if (!loginPrompt) return
    try {
      await vn.piLoginAnswer(loginPrompt.id, loginAnswer)
    } catch (error) {
      setMessage(String(error))
    }
  }

  const cancelLogin = async () => {
    try {
      await vn.piLoginCancel()
    } catch (error) {
      setMessage(String(error))
    }
  }

  const handleStartOAuth = async () => {
    setOauthPending(true)
    setOauthError(null)
    setOauthStatusText('正在打开浏览器登录页面…')
    try {
      await vn.piLoginOAuth(currentProviderId)
    } catch (e: any) {
      setOauthError(`登录失败: ${e.message}`)
      setMessage(`登录失败: ${e.message}`)
    } finally {
      setOauthPending(false)
      setLoginPrompt(null)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      if (editingKey && apiKeyInput.trim()) {
        await vn.piSetApiKey(currentProviderId, apiKeyInput.trim())
        setApiKeyInput('')
        setEditingKey(false)
        await loadProviderStatuses()
      }
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
        <button onClick={onClose} disabled={oauthPending}>返回</button>
        <button className="primary" onClick={() => void save()} disabled={saving || keySaving || oauthPending}>保存</button>
      </header>

      <main className="sheet">
        {/* Unified Model & Auth Card */}
        <section>
          <h3>纪要模型</h3>
          <p className="hint">选择用于将转写稿提炼为会议纪要的 AI 模型与对应授权。</p>

          <label>
            <span>服务商</span>
            <select
              value={isCustomProvider ? 'custom' : currentProviderId}
              onChange={e => handleProviderChange(e.target.value)}
              disabled={oauthPending}
            >
              {providerStatuses.map(p => (
                <option key={p.id} value={p.id} disabled={!p.models.length}>{p.name}</option>
              ))}
              <option value="custom">手动输入模型标识…</option>
            </select>
          </label>

          {isCustomProvider ? (
            <label>
              <span>模型标识 (provider/id)</span>
              <input
                value={currentModel}
                placeholder="例如 ollama/qwen2.5；目录外模型需先在 models.json 配置"
                onChange={e => setEnv({ ...env, VOICENOTE_PI_MODEL: e.target.value.trim() })}
              />
            </label>
          ) : (
            <label>
              <span>模型</span>
              <select
                value={currentModel}
                onChange={e => handleModelChange(e.target.value)}
              >
                <option value="">使用引擎默认模型</option>
                {availableModels.map(m => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </label>
          )}

          {/* Authentication area for selected provider */}
          <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 12 }}>
            {(() => {
              const isOAuthConfigured = currentStatus?.authType === 'oauth'
              const isApiKeyConfigured = currentStatus?.authType === 'api_key'
              const currentTabConfigured = authMethodChoice === 'api_key'
                ? isApiKeyConfigured
                : (currentProviderMeta.hasOAuth ? isOAuthConfigured : isConfigured)

              return (
                <>
                  <div className="sheet-row" style={{ marginBottom: 8 }}>
                    <span style={{ fontWeight: 550 }}>认证凭证 ({currentProviderMeta.name})</span>
                    {currentTabConfigured ? (
                      <span className="pill ok">✓ 已配置 {currentStatus?.source === 'environment' ? '(环境变量)' : ''}</span>
                    ) : (
                      <span className="pill" style={{ color: 'var(--warn)' }}>未配置认证</span>
                    )}
                  </div>

                  {/* Toggle if both OAuth and API key are available */}
                  {currentProviderMeta.hasApiKey && currentProviderMeta.hasOAuth && (
                    <div className="segmented" style={{ marginBottom: 10, width: 'fit-content' }}>
                      <button
                        type="button"
                        className={authMethodChoice === 'oauth' ? 'on' : ''}
                        onClick={() => setAuthMethodChoice('oauth')}
                      >
                        OAuth 登录
                      </button>
                      <button
                        type="button"
                        className={authMethodChoice === 'api_key' ? 'on' : ''}
                        onClick={() => setAuthMethodChoice('api_key')}
                      >
                        API Key
                      </button>
                    </div>
                  )}

                  {/* API Key Form */}
                  {(!currentProviderMeta.hasOAuth || authMethodChoice === 'api_key') && (
                    <div>
                      {isApiKeyConfigured && !editingKey ? (
                        <div className="sheet-row">
                          <span className="mono" style={{ fontSize: 13, userSelect: 'text' }}>
                            {currentStatus?.apiKey ? `Key: ${currentStatus.apiKey}` : 'API Key 已配置 (环境变量)'}
                          </span>
                          <div className="row-actions">
                            <button onClick={() => { setEditingKey(true); setApiKeyInput(currentStatus?.apiKey || '') }}>修改 Key</button>
                            <button className="link" onClick={() => void handleRemoveAuth()} style={{ color: 'var(--danger)' }}>清除</button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input
                            type="text"
                            autoFocus={editingKey}
                            placeholder={`输入 ${currentProviderMeta.name} API Key (例如 sk-...)`}
                            value={apiKeyInput}
                            onChange={e => { setEditingKey(true); setApiKeyInput(e.target.value) }}
                            onKeyDown={e => { if (e.key === 'Enter') void handleSaveKey() }}
                          />
                          <button
                            className="primary"
                            style={{ flex: 'none', whiteSpace: 'nowrap' }}
                            onClick={() => void handleSaveKey()}
                            disabled={saving || keySaving || !apiKeyInput.trim()}
                          >
                            {keySaving ? '保存中…' : '保存 Key'}
                          </button>
                          {editingKey && (
                            <button style={{ flex: 'none' }} onClick={() => { setEditingKey(false); setApiKeyInput('') }}>
                              取消
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* OAuth Login */}
                  {currentProviderMeta.hasOAuth && (authMethodChoice === 'oauth' || !currentProviderMeta.hasApiKey) && (
                    <div>
                      <div className="sheet-row">
                        <span className="hint">
                          {isOAuthConfigured ? '已通过浏览器完成账号授权，可正常生成纪要。' : '需要完成一次浏览器授权以绑定账号。'}
                        </span>
                        <div className="row-actions">
                          <button
                            className={isOAuthConfigured ? '' : 'primary'}
                            onClick={() => void handleStartOAuth()}
                            disabled={oauthPending}
                          >
                            {oauthPending ? '正在授权…' : isOAuthConfigured ? '重新登录' : '授权登录'}
                          </button>
                          {isOAuthConfigured && (
                            <button className="link" onClick={() => void handleRemoveAuth()} style={{ color: 'var(--danger)' }}>
                              退出
                            </button>
                          )}
                        </div>
                      </div>

                      {oauthError && (
                        <div style={{ color: 'var(--danger)', fontSize: 12.5, marginTop: 8 }}>
                          {oauthError}
                        </div>
                      )}

                      {oauthPending && (
                        <div className="oauth-pending-box" style={{ marginTop: 8 }}>
                          <span className="pulse" />
                          <div style={{ flex: 1 }}>
                            <p>{oauthStatusText || '请在浏览器中完成授权。'}</p>
                            {loginPrompt && (
                              <div>
                                <p>{loginPrompt.prompt.message}</p>
                                {loginPrompt.prompt.type === 'select' ? (
                                  <select aria-label={loginPrompt.prompt.message} value={loginAnswer} onChange={e => setLoginAnswer(e.target.value)}>
                                    {loginPrompt.prompt.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                                  </select>
                                ) : (
                                  <input aria-label={loginPrompt.prompt.message} value={loginAnswer} onChange={e => setLoginAnswer(e.target.value)} />
                                )}
                                <button onClick={() => void submitLoginAnswer()}>继续</button>
                              </div>
                            )}
                          </div>
                          <button onClick={() => void cancelLogin()}>取消</button>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )
            })()}
          </div>
        </section>

        {/* Identity */}
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

        {/* Processing */}
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

        {/* About */}
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
