import { expect, test } from 'bun:test'
import { tosObject, type TosConfig } from './tos'

const config: TosConfig = {
  endpoint: 'tos-s3-cn-test.volces.com',
  region: 'cn-test',
  bucket: 'voice-bucket',
  accessKey: 'AKID',
  secretKey: 'secret',
  keep: false,
}

test('TOS uses its virtual-host endpoint and safely encodes object keys', () => {
  const url = new URL(tosObject(config, 'folder/a b-测试.mp3').presign({ method: 'GET', expiresIn: 60 }))
  expect(url.host).toBe('voice-bucket.tos-s3-cn-test.volces.com')
  expect(url.pathname).toBe('/folder/a%20b-%E6%B5%8B%E8%AF%95.mp3')
  expect(url.searchParams.get('X-Amz-Credential')).toContain('/cn-test/s3/aws4_request')
  expect(url.searchParams.get('X-Amz-Expires')).toBe('60')
})
