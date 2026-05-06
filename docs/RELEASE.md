# Releasing MindForest desktop

The `Release` GitHub Actions workflow at
[`.github/workflows/release.yml`](../.github/workflows/release.yml)
builds the macOS bundle on every `v*` tag and on manual dispatch. With
the right secrets set it produces a fully signed + notarized `.app` and
`.dmg`; without them it falls through to an unsigned build that runs
locally but Gatekeeper-blocks on other machines.

## What you need from Apple

Before signing can work end to end you need:

1. **Apple Developer Program membership** — $99/year. Sets up the
   identities below.
2. **Developer ID Application certificate** — issued from Apple
   Developer → Certificates → "+ → Developer ID Application". Download
   the `.cer`, double-click to install in Keychain, then export to
   `.p12` (right-click in Keychain Access → Export → choose a password).
3. **App-specific password** — generated at
   <https://appleid.apple.com> under "Sign-in and Security → App-Specific
   Passwords". Used as `APPLE_PASSWORD`.
4. **Team ID** — 10-char identifier shown in your Apple Developer
   account membership page.

## Repo secrets to set

In GitHub: **Settings → Secrets and variables → Actions → New repository
secret**.

| Secret | Source |
|---|---|
| `APPLE_CERTIFICATE` | `base64 -i developer-id-application.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | The password you used at `.p12` export |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_PASSWORD` | App-specific password from above |
| `APPLE_TEAM_ID` | 10-char team id |

The workflow auto-detects whether `APPLE_SIGNING_IDENTITY` is non-empty
and either signs or builds unsigned. No conditional config edit
required.

## Local signed build

If you want to build a signed bundle on your own machine instead of
through CI:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # app-specific password
export APPLE_TEAM_ID="ABCD123456"

cd rust/apps/desktop
cargo tauri build --target universal-apple-darwin
```

The certificate must already be in your login Keychain — Tauri picks it
up from the Apple-side helper (`security find-identity`), so the
`APPLE_CERTIFICATE` env vars are only needed in CI where there's no
preinstalled keychain.

First-time notarization can take an hour or more while Apple looks at
your binaries; subsequent runs typically finish in 5–10 minutes.

## Hardened runtime / entitlements

The bundle ships with hardened runtime entitlements at
[`rust/apps/desktop/entitlements.plist`](../rust/apps/desktop/entitlements.plist).
The list is intentionally minimal:

- `com.apple.security.cs.allow-jit` — WebKit JIT compiler for the
  bundled webview
- `com.apple.security.cs.disable-library-validation` — load the unsigned
  mlx-swift dylibs the embed sidecar pulls in
- `com.apple.security.network.client` — outbound HF model download +
  optional cloud agent providers
- `com.apple.security.network.server` — the in-process axum API binds
  127.0.0.1:0

We are NOT sandboxed. The user picks a vault directory which can sit
anywhere; sandboxing it would require either prompting for folder
access on every launch or burning entitlements on broad fs access,
neither of which fit a notes app.

## Troubleshooting

- **"resource fork, Finder information, or similar detritus not
  allowed"** — re-run with `xattr -cr rust/target/universal-apple-darwin/release/bundle/macos/MindForest.app`,
  or delete and re-build.
- **Notarization rejected with `The signature does not include a secure
  timestamp`** — the .p12 wasn't a Developer ID cert, or you used `xcrun
  altool --notarize-app` (deprecated). Tauri uses `notarytool` under the
  hood, which is the right path.
- **Tauri can't find the embed sidecar** — make sure
  `rust/apps/embed-sidecar/scripts/stage-for-tauri.sh` ran before
  `cargo tauri build`. The CI workflow does this for you.
