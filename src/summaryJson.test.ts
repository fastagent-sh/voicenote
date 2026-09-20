import { describe, expect, test } from 'bun:test'
import { extractFirstJsonObject, parseSummaryJson } from './summaryJson.ts'

describe('extractFirstJsonObject', () => {
  test('strips a code fence', () => {
    expect(extractFirstJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })
  test('finds the object inside surrounding prose', () => {
    expect(extractFirstJsonObject('Sure!\n{"a":{"b":2}}\nHope that helps')).toBe('{"a":{"b":2}}')
  })
  test('ignores braces inside strings', () => {
    expect(extractFirstJsonObject('{"a":"} not the end"}')).toBe('{"a":"} not the end"}')
  })
})

describe('parseSummaryJson', () => {
  test('parses a well-formed reply', () => {
    expect(parseSummaryJson('{"title":"t","markdown":"# t"}')).toEqual({ title: 't', markdown: '# t' })
  })

  // Observed in a real run: the model wrote the markdown body with real
  // newlines inside the JSON string, and JSON.parse rejected the whole reply
  // ("Bad control character in string literal") after a 4-minute generation.
  test('repairs raw newlines and tabs inside strings', () => {
    const reply = '{"title":"t","markdown":"# t\nline two\tindented"}'
    expect(parseSummaryJson(reply)).toEqual({ title: 't', markdown: '# t\nline two\tindented' })
  })

  test('still reports the original error when the reply is not JSON at all', () => {
    expect(() => parseSummaryJson('sorry, I cannot help with that')).toThrow()
  })
})
