# Launch checklist (plumbing week) — 2026-09-07

Status of the "make it launchable" work. Done items are in the repo; the rest need the
maintainer's accounts.

## Done in the repo (branch `fix/codex-exec-no-full-auto`)

- Headless Codex launch fixed for codex-cli 0.147+ (`--full-auto` removed upstream); argv
  probe stops a seat with `MOE_CLI_ARGV_REJECTED` instead of relaunch-looping.
- Versions synced to **0.8.0** everywhere `scripts/verify-release-version.mjs` checks.
- One name: **Moe's Tavern**, tagline **AI agent task board** (README, plugin.xml,
  moe-vscode/package.json, docs/index.html, npm package descriptions). Technical ids unchanged.
- `.github/workflows/release.yml` publishes the VS Code extension (`VSCE_PAT`) and Open VSX
  (`OVSX_PAT`) in addition to npm (`NPM_TOKEN`) and JetBrains Marketplace
  (`JETBRAINS_MARKETPLACE_TOKEN`). `.github/release.yml` keeps dependabot out of release notes.
- README "Install from a marketplace (v0.8.0 and later)" section; `docs/RELEASING.md`.
- Worker rail: an out-of-scope bug becomes a card (`moe.create_task`), not a detour — the demo moment.
- GitHub repo description, homepage and topics set; issue #16 closed (shipped in #26);
  five scoped issues opened (#159–#163, three `good first issue`).

## Only the maintainer can do these (in order)

1. **Create the four secrets** (repo → Settings → Secrets and variables → Actions):
   - `NPM_TOKEN` — npmjs.com → Access Tokens → Granular, packages `moe-daemon` + `moe-proxy`
     (create them by first publishing once from a laptop, or grant "all packages"), publish permission.
     `--provenance` needs the repo public (it is).
   - `JETBRAINS_MARKETPLACE_TOKEN` — hub.jetbrains.com → profile → Authentication → new
     permanent token. First upload of `com.moe.jetbrains` goes through JetBrains moderation
     (1–3 business days); the listing appears only after approval.
   - `VSCE_PAT` — create publisher `yaront1111` at marketplace.visualstudio.com/manage first, then
     dev.azure.com → Personal access tokens → Organization "All accessible organizations",
     scope Marketplace → Manage.
   - `OVSX_PAT` (optional) — open-vsx.org → claim namespace `yaront1111` → Access Tokens.
2. **Merge the branch** (PR to `main`; CI must be green — see "Open" below), then tag:
   `git tag v0.8.0 && git push origin v0.8.0`. The Release workflow builds, verifies onboarding,
   attaches the zip + .vsix, and publishes to every channel whose secret exists.
3. **Reinstall your own plugin** so your fleet stops relaunch-looping:
   `.\scripts\install-all.ps1 -BuildPlugin -InstallPlugin -IdeVersion PyCharm2026.1`, then
   restart the codex worker terminal.
4. **Add a `## [0.8.0]` line to `moe-vscode/CHANGELOG.md`** on each future bump (docs/RELEASING.md).

## Open

- **CI on Windows (PowerShell 5.1 postflight)** has never passed on a GitHub runner — the step
  was added in d8bea8b; it throws at the harness's `Get-FileHash` on the grok config (Scenario Y)
  and does not reproduce locally on PS 5.1 or 7. The rerun of the failed job on d5ca4d7 tells
  flake vs deterministic; the branch swaps `Get-FileHash` for a .NET SHA-256 over bytes the
  harness already reads. If it still fails on the runner, run the job with
  `MOE_POSTFLIGHT_KEEP_TEMP=1` and print the wrapper log.
- **Release notes categories** key on PR labels (GitHub has no title matching); label PRs
  `feat`/`fix`/`docs` or expect "Other changes".
- **The demo GIF** (45 s, no narration): task → architect plan → approve → worker → mid-task bug
  becomes a card → QA → done. Cut the 10 s "bug becomes a card" moment for README and posts.

## Launch wave (after the marketplaces list 0.8.0)

- Show HN, Tue–Thu ~15:00 Israel time. Title: "Show HN: Moe's Tavern – an AI agent task board
  that lives in .moe/ in your repo". First comment: the origin story + what is still rough
  (JetBrains-first, VS Code board newer, Windows-first testing).
- Next day: r/ClaudeAI, r/ClaudeCode as a workflow post ("how I stopped Claude Code from
  derailing mid-task"), then r/ChatGPTCoding with Codex framing. X: quote the "sub agents
  released into my codebase" clip with the demo. LinkedIn + Hebrew dev groups with the same GIF.
- Week later: a written piece — "Your agents need a task board, not a longer prompt".
- Measure installs (npm downloads, Marketplace installs), not stars.
