# Releasing

Releases are tag-driven. Pushing `vX.Y.Z` runs `.github/workflows/release.yml`, which builds everything, publishes to npm, the VS Code Marketplace, Open VSX and the JetBrains Marketplace (each channel only when its secret is set), and attaches the plugin ZIP and `.vsix` to a GitHub Release.

## 1. Bump versions

All package versions are kept in sync. Set the same `X.Y.Z` in:

- `packages/moe-daemon/package.json` and `package-lock.json` (top-level `version` **and** `packages[""].version`)
- `packages/moe-proxy/package.json` and `package-lock.json`
- `packages/moe-claude-plugin/package.json` and `package-lock.json`
- `moe-vscode/package.json` and `package-lock.json`
- `moe-jetbrains/build.gradle.kts` (`version = "X.Y.Z"`)

Update `<change-notes>` in `moe-jetbrains/src/main/resources/META-INF/plugin.xml` and `moe-vscode/CHANGELOG.md`.

## 2. Verify

```bash
node scripts/verify-release-version.mjs vX.Y.Z   # must print "PASS release versions: X.Y.Z"
```

The workflow runs the same check first and stops on a mismatch. Commit the bump to `main` before tagging.

## 3. Tag and push

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

## What the workflow does

`build-and-release`: verify versions → build daemon and proxy → onboarding smoke test → `./gradlew buildPlugin` → `vsce package` → smoke-test both artifacts → `npm publish --provenance` (daemon, proxy) → GitHub Release with auto-generated notes and the ZIP + `.vsix` attached → `vsce publish` → `ovsx publish`.

`publish-plugin` (runs after it): rebuild daemon and proxy, then `./gradlew publishPlugin`.

Every publish step is **skipped, not failed**, when its secret is empty. Release notes are generated from `.github/release.yml`: PRs are grouped by label (`feat`/`feature`/`enhancement`, `fix`/`bug`, `docs`/`documentation`, everything else under Other) and dependabot PRs are excluded.

## Secrets

Set these under GitHub → Settings → Secrets and variables → Actions.

| Secret | Where to get it | Notes |
|---|---|---|
| `NPM_TOKEN` | npmjs.com → Access Tokens → **Granular Access Token** with read and write on `moe-daemon` and `moe-proxy` | The workflow publishes with `--provenance`, which requires a granular/automation token (a classic token that prompts for 2FA fails in CI) and a **public** GitHub repository; the workflow already grants `id-token: write`. |
| `JETBRAINS_MARKETPLACE_TOKEN` | https://plugins.jetbrains.com/author/me/tokens (a JetBrains Hub permanent token) | Exported as `PUBLISH_TOKEN`, which the IntelliJ Platform Gradle Plugin reads by default. `publishPlugin` can create the listing on the **first** upload of a new plugin; that first version goes through JetBrains moderation, typically 1–3 business days. Later versions publish immediately. |
| `VSCE_PAT` | Azure DevOps → User settings → Personal access tokens: Organization **All accessible organizations**, scope **Marketplace → Manage** | The publisher `yaront1111` must exist at https://marketplace.visualstudio.com/manage before the first publish. `vsce` reads `VSCE_PAT`. |
| `OVSX_PAT` | https://open-vsx.org → your profile → Access Tokens | The namespace `yaront1111` must be created/claimed first (`npx ovsx create-namespace yaront1111 -p <token>`). `ovsx` reads `OVSX_PAT`. |

## After the run

- Check the GitHub Release page, `npm view moe-daemon version`, `npm view moe-proxy version`, both VS Code listings, and the JetBrains Marketplace (first version: wait for moderation).
- To retry a failed run, fix the cause, delete the tag and the draft/failed Release, and push the tag again. npm refuses to re-publish an existing version, so a run that already published to npm needs a new patch version.
