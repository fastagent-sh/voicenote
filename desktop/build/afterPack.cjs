// Sign the packaged app with a plain code-signing identity.
//
// electron-builder only signs with an identity macOS considers *valid*, which
// means a paid Developer ID. Squirrel.Mac, on the other hand, only needs the
// update's signature to satisfy the running app's designated requirement — a
// self-signed certificate reused across releases can do that, even though
// Gatekeeper still asks the user to approve the first launch.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  const identity = process.env.VN_SIGN_IDENTITY
  if (!identity || context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const keychain = process.env.VN_SIGN_KEYCHAIN ? ['--keychain', process.env.VN_SIGN_KEYCHAIN] : []
  execFileSync('codesign', ['--force', '--deep', '--timestamp=none', '--sign', identity, ...keychain, appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'inherit' })
}
