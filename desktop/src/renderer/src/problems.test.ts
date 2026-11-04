import { expect, test } from 'bun:test'
import { explainFailure } from './problems.ts'

test('transcription authentication errors point to ASR settings', () => {
  const result = explainFailure({ code: 'transcribe_failed', detail: 'Volcano submit failed: status=45000010 message=Invalid X-Api-Key (attempt 1/3)' })
  expect(result.message).toContain('火山 ASR 密钥')
  expect(result.action?.kind).toBe('settings')
  expect(result.attempts).toBe('第 1 次尝试,共 3 次')
})

test('summary authentication errors point to the configured model', () => {
  const result = explainFailure({ code: 'summary_failed', detail: 'No API key found for deepseek' })
  expect(result.message).toContain('纪要模型认证失败')
  expect(result.message).not.toContain('ChatGPT')
  expect(result.action?.kind).toBe('settings')
})

test('OAuth mentioned in documentation does not turn a network failure into an auth error', () => {
  const result = explainFailure({ code: 'summary_failed', detail: 'fetch failed; see OAuth documentation' })
  expect(result.message).toContain('网络')
  expect(result.action?.kind).toBe('retry')
})
