import { expect, test } from 'bun:test'
import { isFresh, spokenDuration, timeGroup } from './format.ts'

test('a note counts as fresh for ten minutes after it is written', () => {
  expect(isFresh(new Date().toISOString())).toBe(true)
  expect(isFresh(new Date(Date.now() - 9 * 60_000).toISOString())).toBe(true)
  expect(isFresh(new Date(Date.now() - 11 * 60_000).toISOString())).toBe(false)
  expect(isFresh(null)).toBe(false)
  expect(isFresh('not a date')).toBe(false)
})

// Short recordings keep their seconds: the number is why they were skipped.
test('durations read the way a person would say them', () => {
  expect(spokenDuration(7)).toBe('7 秒')
  expect(spokenDuration(150)).toBe('3 分钟')
  expect(spokenDuration(10623)).toBe('2 小时 57 分')
  expect(spokenDuration(null)).toBeNull()
})

test('grouping buckets by how long ago the recording was made', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString().slice(0, 16).replace('T', ' ')
  expect(timeGroup(ago(60_000))).toBe('今天')
  expect(timeGroup(ago(3 * 86_400_000))).toBe('本周')
  expect(timeGroup(ago(60 * 86_400_000))).toBe('更早')
})
