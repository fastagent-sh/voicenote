export type TosConfig = {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  keep: boolean
}

export function tosObject(config: TosConfig, key: string): Bun.S3File {
  return new Bun.S3Client({
    accessKeyId: config.accessKey,
    secretAccessKey: config.secretKey,
    region: config.region,
    endpoint: `https://${config.bucket}.${config.endpoint}`,
    virtualHostedStyle: true,
  }).file(key)
}
