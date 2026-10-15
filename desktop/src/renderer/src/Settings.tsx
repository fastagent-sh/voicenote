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

type ProviderPreset = {
  id: string
  name: string
  models: { id: string; label: string }[]
  hasApiKey: boolean
  hasOAuth: boolean
  oauthLabel?: string
}

const PROVIDER_RECOMMENDED_MODELS: Record<string, string> = {
  deepseek: 'deepseek/deepseek-flash',
  'openai-codex': 'openai-codex/gpt-6.1-sol',
  openai: 'openai/gpt-4o',
  anthropic: 'anthropic/claude-sonnet-5-5',
  'kimi-coding': 'kimi-coding/kimi-for-coding',
  minimax: 'minimax/MiniMax-Text-01',
  'qwen-token-plan-cn': 'qwen-token-plan-cn/qwen3.6-plus',
  openrouter: 'openrouter/deepseek/deepseek-chat',
}

const PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    hasApiKey: true,
    hasOAuth: false,
    models: [
      { id: 'deepseek/deepseek-flash', label: 'DeepSeek V4.1 Flash (推荐)' },
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek-V3 (deepseek-chat)' },
      { id: 'deepseek/deepseek-reasoner', label: 'DeepSeek-R1 (deepseek-reasoner 深度思考)' },
    ],
  },
  {
    id: 'openai-codex',
    name: 'ChatGPT (Plus/Pro 账号)',
    hasApiKey: false,
    hasOAuth: true,
    oauthLabel: 'ChatGPT 账号授权',
    models: [
      { id: 'openai-codex/gpt-6.1-sol', label: 'GPT-6.1 Sol (最新推荐)' },
      { id: 'openai-codex/gpt-6-sol', label: 'GPT-6 Sol' },
      { id: 'openai-codex/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { id: 'openai-codex/gpt-5.5', label: 'GPT-5.5' },
      { id: 'openai-codex/gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI (API Key)',
    hasApiKey: true,
    hasOAuth: false,
    models: [
      { id: 'openai/gpt-4o', label: 'GPT-4o (推荐)' },
      { id: 'openai/gpt-4.1', label: 'GPT-4.1' },
      { id: 'openai/o3-mini', label: 'o3-mini' },
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o-mini' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    hasApiKey: true,
    hasOAuth: true,
    oauthLabel: 'Claude 订阅授权 (Pro/Max)',
    models: [
      { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (最新最优推荐)' },
      { id: 'anthropic/claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' },
      { id: 'anthropic/claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
    ],
  },
  {
    id: 'kimi-coding',
    name: 'Kimi For Coding',
    hasApiKey: true,
    hasOAuth: true,
    oauthLabel: 'Kimi 账号授权',
    models: [
      { id: 'kimi-coding/kimi-for-coding', label: 'kimi-for-coding' },
      { id: 'kimi-coding/k3', label: 'Kimi K3' },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    hasApiKey: true,
    hasOAuth: false,
    models: [
      { id: 'minimax/MiniMax-Text-01', label: 'MiniMax-Text-01' },
      { id: 'minimax/MiniMax-M2.7', label: 'MiniMax-M2.7' },
    ],
  },
  {
    id: 'qwen-token-plan-cn',
    name: '通义千问 (Qwen)',
    hasApiKey: true,
    hasOAuth: false,
    models: [
      { id: 'qwen-token-plan-cn/qwen3.6-plus', label: 'Qwen 3.6 Plus' },
      { id: 'qwen-token-plan-cn/deepseek-v3.2', label: 'DeepSeek V3.2' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    hasApiKey: true,
    hasOAuth: true,
    oauthLabel: 'OpenRouter 授权',
    models: [
      { id: 'openrouter/deepseek/deepseek-chat', label: 'DeepSeek V3 (via OpenRouter)' },
      { id: 'openrouter/auto', label: 'Auto Router' },
    ],
  },
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
  const [keySaving, setKeySaving] = useState(false)

  const [authMethodChoice, setAuthMethodChoice] = useState<'oauth' | 'api_key'>('oauth')
  const [oauthPending, setOauthPending] = useState(false)
  const [oauthStatusText, setOauthStatusText] = useState<string | null>(null)

  const loadProviderStatuses = async () => {
    try {
      const list = await vn.piProviders()
      setProviderStatuses(list)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    void vn.configGet().then(config => {
      setEnv(config.env)
      setSelf(config.self)
    })
    void vn.updateState().then(state => setVersion(state.version))
    void loadProviderStatuses()

    return vn.on('login:event', (event: LoginEvent) => {
      if (event.event === 'auth_url') {
        setOauthStatusText('已打开浏览器，请在网页中完成授权…')
      }
      if (event.event === 'device_code') {
        setOauthStatusText(`设备授权码: ${event.userCode}，已打开验证页面`)
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
        setOauthStatusText(`登录失败: ${event.message}`)
        setOauthPending(false)
      }
    })
  }, [])

  const currentModel = env.VOICENOTE_PI_MODEL ?? ''
  const currentProviderId = (currentModel ? currentModel.split('/')[0] : 'openai-codex') || 'openai-codex'

  const matchedPreset = PROVIDERS.find(p => p.id === currentProviderId)
  const isCustomProvider = !matchedPreset && currentModel !== ''

  const currentStatus = providerStatuses.find(p => p.id === currentProviderId)
  const isConfigured = currentStatus?.configured ?? false

  const currentProviderMeta = matchedPreset ?? {
    id: currentProviderId,
    name: currentStatus?.name ?? currentProviderId,
    hasApiKey: currentStatus?.hasApiKey ?? true,
    hasOAuth: currentStatus?.hasOAuth ?? false,
    models: [],
  }

  // Dynamically populate models from pi-ai catalog, falling back to presets
  const dynamicModels = (currentStatus?.models ?? []).map(m => ({
    id: `${currentProviderId}/${m.id}`,
    label: m.name,
  }))
  const fallbackModels = matchedPreset ? matchedPreset.models.map(m => ({ ...m })) : []
  const availableModels = dynamicModels.length > 0 ? dynamicModels : fallbackModels

  // Put recommended/optimal model at the top
  const bestModelId = PROVIDER_RECOMMENDED_MODELS[currentProviderId]
  if (bestModelId) {
    const idx = availableModels.findIndex(m => m.id === bestModelId)
    if (idx > 0) {
      const best = availableModels[idx]
      if (best) {
        availableModels.splice(idx, 1)
        availableModels.unshift(best)
      }
    }
  }

  // Ensure currentModel is always present in options if set
  if (currentModel && !availableModels.some(m => m.id === currentModel)) {
    availableModels.unshift({ id: currentModel, label: currentModel })
  }

  const handleProviderChange = (newProviderId: string) => {
    setEditingKey(false)
    setApiKeyInput('')
    if (newProviderId === 'custom') {
      setEnv({ ...env, VOICENOTE_PI_MODEL: 'custom/model-id' })
      return
    }
    const targetPreset = PROVIDERS.find(p => p.id === newProviderId)
    // Always default to the most advanced / recommended model for this provider
    const bestModel = PROVIDER_RECOMMENDED_MODELS[newProviderId]
      || targetPreset?.models[0]?.id
      || `${newProviderId}/default`
    setEnv({ ...env, VOICENOTE_PI_MODEL: bestModel })
    if (targetPreset?.hasApiKey && !targetPreset.hasOAuth) {
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
      await loadProviderStatuses()
    } catch (e: any) {
      setMessage(`清除失败: ${e.message}`)
    }
  }

  const handleStartOAuth = async () => {
    setOauthPending(true)
    setOauthStatusText('正在打开浏览器登录页面…')
    try {
      await vn.piLoginOAuth(currentProviderId)
    } catch (e: any) {
      setMessage(`登录失败: ${e.message}`)
      setOauthPending(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      if (apiKeyInput.trim()) {
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
        <button onClick={onClose}>返回</button>
        <button className="primary" onClick={() => void save()} disabled={saving}>保存</button>
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
            >
              <optgroup label="常用服务商">
                {PROVIDERS.slice(0, 4).map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </optgroup>
              <optgroup label="更多服务商">
                {PROVIDERS.slice(4).map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
                <option value="custom">自定义模型 (手动输入)…</option>
              </optgroup>
            </select>
          </label>

          {isCustomProvider ? (
            <label>
              <span>模型标识 (provider/id)</span>
              <input
                value={currentModel}
                placeholder="例如 ollama/qwen2.5 或 openai/gpt-4o"
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
                {availableModels.map(m => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </label>
          )}

          {/* Authentication area for selected provider */}
          <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 12 }}>
            <div className="sheet-row" style={{ marginBottom: 8 }}>
              <span style={{ fontWeight: 550 }}>认证凭证 ({currentProviderMeta.name})</span>
              {isConfigured ? (
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
            {(authMethodChoice === 'api_key' || (currentProviderMeta.hasApiKey && !currentProviderMeta.hasOAuth)) && (
              <div>
                {isConfigured && !editingKey ? (
                  <div className="sheet-row">
                    <span className="mono" style={{ fontSize: 13, userSelect: 'text' }}>
                      {currentStatus?.apiKey ? `Key: ${currentStatus.apiKey}` : 'API Key 已配置'}
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
                      onChange={e => setApiKeyInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') void handleSaveKey() }}
                    />
                    <button
                      className="primary"
                      style={{ flex: 'none', whiteSpace: 'nowrap' }}
                      onClick={() => void handleSaveKey()}
                      disabled={keySaving || !apiKeyInput.trim()}
                    >
                      {keySaving ? '保存中…' : '保存 Key'}
                    </button>
                    {editingKey && (
                      <button style={{ flex: 'none' }} onClick={() => setEditingKey(false)}>
                        取消
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* OAuth Login */}
            {(authMethodChoice === 'oauth' || (!currentProviderMeta.hasApiKey && currentProviderMeta.hasOAuth)) && (
              <div>
                <div className="sheet-row">
                  <span className="hint">
                    {isConfigured ? '已通过浏览器完成账号授权，可正常生成纪要。' : '需要完成一次浏览器授权以绑定账号。'}
                  </span>
                  <div className="row-actions">
                    <button
                      className={isConfigured ? '' : 'primary'}
                      onClick={() => void handleStartOAuth()}
                      disabled={oauthPending}
                    >
                      {oauthPending ? '正在授权…' : isConfigured ? '重新登录' : '授权登录'}
                    </button>
                    {isConfigured && (
                      <button className="link" onClick={() => void handleRemoveAuth()} style={{ color: 'var(--danger)' }}>
                        退出
                      </button>
                    )}
                  </div>
                </div>

                {oauthPending && (
                  <div className="oauth-pending-box" style={{ marginTop: 8 }}>
                    <span className="pulse" />
                    <span style={{ flex: 1 }}>{oauthStatusText || '已在浏览器打开登录页，请在网页中完成授权…'}</span>
                    <button onClick={() => { setOauthPending(false); setOauthStatusText(null) }}>取消</button>
                  </div>
                )}
              </div>
            )}
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
