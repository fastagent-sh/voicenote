import { useEffect, useState } from 'react'
import { vn, type LoginEvent, type ProviderInfo } from './api.ts'

export interface ModelAuthCardProps {
  currentModel: string
  onModelChange: (model: string) => void
  disabled?: boolean
  onStatusChange?: () => void
  compact?: boolean
}

export function ModelAuthCard({
  currentModel,
  onModelChange,
  disabled = false,
  onStatusChange,
  compact = false,
}: ModelAuthCardProps) {
  const [providerStatuses, setProviderStatuses] = useState<ProviderInfo[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState<string>('openai-codex')
  const [manualModel, setManualModel] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [editingKey, setEditingKey] = useState(false)
  const [keySaving, setKeySaving] = useState(false)
  const [authMethodChoice, setAuthMethodChoice] = useState<'oauth' | 'api_key'>('oauth')
  const [oauthPending, setOauthPending] = useState(false)
  const [oauthError, setOauthError] = useState<string | null>(null)
  const [oauthStatusText, setOauthStatusText] = useState<string | null>(null)
  const [loginPrompt, setLoginPrompt] = useState<{ id: number; question: string } | null>(null)
  const [promptAnswer, setPromptAnswer] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  const loadProviderStatuses = async () => {
    try {
      const providers = await vn.piProviders()
      setProviderStatuses(providers)
      onStatusChange?.()
    } catch (e: any) {
      setMessage(`无法加载服务商状态: ${e.message}`)
    }
  }

  useEffect(() => {
    void loadProviderStatuses()
    if (currentModel) {
      const prov = currentModel.split('/')[0]
      if (prov) setSelectedProviderId(prov)
    }
  }, [])

  useEffect(() => {
    return vn.on('login:event', (event: LoginEvent) => {
      if (event.event === 'prompt') {
        setLoginPrompt({ id: event.id, question: event.prompt.message })
        setPromptAnswer('')
      }
      if (event.event === 'prompt_closed') {
        setLoginPrompt(null)
        setPromptAnswer('')
      }
      if (event.event === 'auth_url') {
        setOauthStatusText('已打开浏览器，完成授权后将自动同步…')
      }
      if (event.event === 'progress') {
        setOauthStatusText(event.message)
      }
      if (event.event === 'success') {
        setOauthPending(false)
        setOauthStatusText('授权成功')
        setOauthError(null)
        setLoginPrompt(null)
        void loadProviderStatuses()
      }
      if (event.event === 'error') {
        setOauthError(`登录失败: ${event.message}`)
        setOauthStatusText(null)
        setOauthPending(false)
      }
    })
  }, [])

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
    onModelChange(`${newProviderId}/${targetStatus.defaultModelId}`)
    if (targetStatus.authType === 'api_key' || !targetStatus.hasOAuth) {
      setAuthMethodChoice('api_key')
    } else {
      setAuthMethodChoice('oauth')
    }
  }

  const handleSaveKey = async () => {
    if (!apiKeyInput.trim()) return
    setKeySaving(true)
    try {
      await vn.piSetApiKey(currentProviderId, apiKeyInput.trim())
      setEditingKey(false)
      setApiKeyInput('')
      await loadProviderStatuses()
    } catch (e: any) {
      setMessage(`保存 API Key 失败: ${e.message}`)
    } finally {
      setKeySaving(false)
    }
  }

  const handleRemoveAuth = async () => {
    try {
      await vn.piRemoveAuth(currentProviderId)
      setEditingKey(false)
      setApiKeyInput('')
      await loadProviderStatuses()
    } catch (e: any) {
      setMessage(`清除授权失败: ${e.message}`)
    }
  }

  const handleOAuthLogin = async () => {
    setOauthPending(true)
    setOauthError(null)
    setOauthStatusText('正在发起授权…')
    try {
      await vn.piLoginOAuth(currentProviderId)
    } catch (e: any) {
      setOauthError(e.message || String(e))
      setOauthPending(false)
      setOauthStatusText(null)
    }
  }

  const isOAuthConfigured = currentStatus?.authType === 'oauth'
  const isApiKeyConfigured = currentStatus?.authType === 'api_key'
  const currentTabConfigured = authMethodChoice === 'api_key'
    ? isApiKeyConfigured
    : (currentProviderMeta.hasOAuth ? isOAuthConfigured : isConfigured)

  return (
    <div>
      {message && <p className="problem" style={{ marginBottom: 12 }}>{message}</p>}
      <label>
        <span>服务商</span>
        <select
          value={isCustomProvider ? 'custom' : currentProviderId}
          onChange={e => handleProviderChange(e.target.value)}
          disabled={disabled || oauthPending}
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
            onChange={e => onModelChange(e.target.value.trim())}
            disabled={disabled || oauthPending}
          />
        </label>
      ) : (
        <label>
          <span>模型</span>
          <select
            value={currentModel}
            onChange={e => onModelChange(e.target.value)}
            disabled={disabled || oauthPending}
          >
            <option value="">使用引擎默认模型</option>
            {availableModels.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
      )}

      <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 12 }}>
        <div className="sheet-row" style={{ marginBottom: 8 }}>
          <span style={{ fontWeight: 550 }}>认证凭证 ({currentProviderMeta.name})</span>
          {currentTabConfigured ? (
            <span className="pill ok">✓ 已配置 {currentStatus?.source === 'environment' ? '(环境变量)' : ''}</span>
          ) : (
            <span className="pill" style={{ color: 'var(--warn)' }}>未配置认证</span>
          )}
        </div>

        {currentProviderMeta.hasApiKey && currentProviderMeta.hasOAuth && (
          <div className="segmented" style={{ marginBottom: 10, width: 'fit-content' }}>
            <button
              type="button"
              className={authMethodChoice === 'oauth' ? 'on' : ''}
              onClick={() => setAuthMethodChoice('oauth')}
              disabled={disabled || oauthPending}
            >
              OAuth 登录
            </button>
            <button
              type="button"
              className={authMethodChoice === 'api_key' ? 'on' : ''}
              onClick={() => setAuthMethodChoice('api_key')}
              disabled={disabled || oauthPending}
            >
              API Key
            </button>
          </div>
        )}

        {(!currentProviderMeta.hasOAuth || authMethodChoice === 'api_key') && (
          <div>
            {isApiKeyConfigured && !editingKey ? (
              <div className="sheet-row">
                <span className="mono" style={{ fontSize: 13, userSelect: 'text' }}>
                  {currentStatus?.apiKey ? `Key: ${currentStatus.apiKey}` : 'API Key 已配置 (环境变量)'}
                </span>
                <div className="row-actions">
                  <button onClick={() => { setEditingKey(true); setApiKeyInput(currentStatus?.apiKey || '') }} disabled={disabled}>修改 Key</button>
                  <button className="link" onClick={() => void handleRemoveAuth()} style={{ color: 'var(--danger)' }} disabled={disabled}>清除</button>
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
                  disabled={disabled}
                />
                <button
                  className="primary"
                  style={{ flex: 'none', whiteSpace: 'nowrap' }}
                  onClick={() => void handleSaveKey()}
                  disabled={disabled || keySaving || !apiKeyInput.trim()}
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

        {currentProviderMeta.hasOAuth && (authMethodChoice === 'oauth' || !currentProviderMeta.hasApiKey) && (
          <div>
            <div className="sheet-row">
              <span className="hint">
                {isOAuthConfigured ? '已通过浏览器完成账号授权，可正常生成纪要。' : '需要完成一次浏览器授权以绑定账号。'}
              </span>
              <div className="row-actions">
                <button
                  className={isOAuthConfigured ? '' : 'primary'}
                  onClick={() => void handleOAuthLogin()}
                  disabled={disabled || oauthPending}
                >
                  {oauthPending ? '授权中…' : (isOAuthConfigured ? '重新授权' : '授权登录')}
                </button>
                {isOAuthConfigured && (
                  <button className="link" onClick={() => void handleRemoveAuth()} style={{ color: 'var(--danger)' }} disabled={disabled || oauthPending}>清除</button>
                )}
              </div>
            </div>

            {oauthStatusText && !oauthError && (
              <p className="hint" style={{ marginTop: 8, color: 'var(--accent)' }}>{oauthStatusText}</p>
            )}

            {loginPrompt && (
              <div style={{ marginTop: 10, padding: 10, background: 'var(--surface)', borderRadius: 6, border: '1px solid var(--line)' }}>
                <p style={{ margin: '0 0 6px 0', fontSize: 13 }}>{loginPrompt.question}</p>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    value={promptAnswer}
                    placeholder="输入代码或内容…"
                    onChange={e => setPromptAnswer(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && promptAnswer.trim()) {
                        void vn.piLoginAnswer(loginPrompt.id, promptAnswer.trim())
                      }
                    }}
                  />
                  <button
                    className="primary"
                    onClick={() => {
                      if (promptAnswer.trim()) void vn.piLoginAnswer(loginPrompt.id, promptAnswer.trim())
                    }}
                  >
                    提交
                  </button>
                  <button onClick={() => void vn.piLoginCancel()}>取消</button>
                </div>
              </div>
            )}

            {oauthError && (
              <div style={{ marginTop: 8 }}>
                <p className="problem" style={{ margin: 0 }}>{oauthError}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
