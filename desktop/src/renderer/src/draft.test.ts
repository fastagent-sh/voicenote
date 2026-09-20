import { describe, expect, test } from 'bun:test'
import { parseDraft } from './draft.ts'

// The model streams one JSON object; every prefix of it has to render as the
// markdown it is becoming, not as raw JSON with visible \n escapes.
describe('parseDraft', () => {
  test('reads a complete answer', () => {
    expect(parseDraft('{"title":"会议","markdown":"# 会议\\n\\n内容"}'))
      .toEqual({ title: '会议', body: '# 会议\n\n内容' })
  })

  test('reads a half-written markdown value', () => {
    expect(parseDraft('{"title":"会议","markdown":"# 会议\\n\\n第一段还没写完').body)
      .toBe('# 会议\n\n第一段还没写完')
  })

  test('survives an escape cut in half', () => {
    expect(parseDraft('{"markdown":"一行\\').body).toBe('一行')
    expect(parseDraft('{"markdown":"一行\\u4e2').body).toBe('一行')
  })

  test('keeps quotes and backslashes that are part of the text', () => {
    expect(parseDraft('{"markdown":"他说\\"好\\",路径 C:\\\\tmp"}').body).toBe('他说"好",路径 C:\\tmp')
  })

  test('shows leading prose while the object has not started', () => {
    expect(parseDraft('让我整理一下…').body).toBe('让我整理一下…')
  })

  test('shows nothing between the brace and the first field', () => {
    expect(parseDraft('{ ').body).toBe('')
  })
})
