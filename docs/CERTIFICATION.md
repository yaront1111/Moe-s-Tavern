# Isolation Certification

`node scripts/local-runner/cli.mjs certify --work-dir <absolute directory>` (`scripts/local-runner/certify.mjs`) is the
only evidence that can establish an isolation support claim for a host platform. It launches real Multipass VMs, so an
operator runs it on real hardware, never CI. Mocks cannot certify: an injected run always reports `transport: 'injected'`
and `certified: false`. The architecture it exercises is in [ARCHITECTURE.md](ARCHITECTURE.md#local-runner-isolation).

## What it never claims

Certification is not activation. Every report carries `executionReady: false`, and `verified-local` stays refused with
`EXECUTION_PROFILE_NOT_READY` ([CONFIGURATION.md](CONFIGURATION.md)) until the client gates in the other epics pass too.
Satisfied `prerequisites` and a passed `native-smoke` (provider support evidence) are never certification.

## What it checks

The checks run in this order. After the first failure the rest are `not-run`, except `teardown`, which always runs.
Each failure is one fixed code; no path, guest byte or credential reaches the report.

| Check | What a pass shows |
|---|---|
| `provision` | One owned VM provisions from the pinned Ubuntu 24.04 image with the real `guest-supervisor.py` and a fresh 32-byte credential. |
| `readiness` | The real boot reaches a clean cloud-init `done`/`done`, then readiness holds: zero mounts, the installed supervisor and MCP shim hashes, the credential and its cloud-init copies denied to the job identities, and locked, unprivileged identities. |
| `no-mounts` | The guest has no host-sharing mount. |
| `bridge-framing` | 2 MiB of frame bytes cross `multipass exec` exactly, in both directions. |
| `bridge-eof` | Host EOF on stdin reaches the supervisor with no pty: it kills the job and exits 74. |
| `guest-network` | Neither job identity can connect to the VM gateway, at certify's own loopback listener or at the default daemon port 9876. |
| `writer-containment` | The agent identity can read neither the supervisor credential nor the root-only workspace manifest, and can write neither `/opt/moe`, another job's home, the supervisor nor the installed toolchain. |
| `check-containment` | Three check runs, each in a fresh VM. The check identity has only `lo` and no route, cannot read the credential, write a protected file or raise its rlimits, and gets `EFBIG` past the file-size limit. A root change of a protected file mid-run resolves `inconclusive` (exit 80), and an edit of a tracked file verifies `changed`. |
| `controller-replacement` | A supervisor replaced as root fails readiness with `SUPERVISOR_HASH_MISMATCH`, and cleanup leaves the VM and its ledger record, rewritten to another owner, alone. |
| `cancellation` | A check run aborted after its session started resolves without `passed`, with its VM deleted and its record `deleted`. |
| `recovery` | A controller child SIGKILLed after its VM launched leaves a real orphan. Reconcile plus cleanup delete exactly that VM, and a foreign record in the same ledger survives. |
| `canary-check` | Three real checks, each in a fresh VM: the pinned Node toolchain, an offline install of `is-number@7.0.0` from a lockfile, then `npm test`. A passing test passes with the workspace intact and the expected environment identity, a failing one is `code-failure`, and an altered lockfile integrity is refused before any session. |
| `teardown` | The certify VM is deleted by its exact owned name. |

## How to run it

1. Install Multipass 1.17.0 with the driver `scripts/local-runner/certified-provider.json` names: Windows x64 `hcs`,
   Linux x64 `qemu` (the snap), macOS x64 or arm64 `qemu`. Keep the installer's default location: Moe runs only the
   pinned client (`%ProgramFiles%\Multipass\bin\multipass.exe`, `/snap/bin/multipass`, `/usr/local/bin/multipass`),
   never a `multipass` found on `PATH`, and reports `PROVIDER_NOT_FOUND` when it is missing.
2. Run `node scripts/local-runner/cli.mjs prerequisites --cache-dir <work-dir>/images`. Certify caches the image in
   `<work-dir>/images`. The command exits 0 only when every item is satisfied, and each unmet item names its `action`.
   On Linux the strictly confined snap reads only paths under your home directory with no hidden segment, so the
   work dir must be one (no segment starting with `.`). On Windows it must be a drive-letter path, not a UNC path.
3. Run `node scripts/local-runner/cli.mjs certify --work-dir <work-dir>`. It prints the report as one JSON line and exits
   0 only when `certified` is true, else 2. A refusal prints only `{code, certified: false, executionReady: false}`:
   `CERTIFY_INPUT_INVALID` or `CERTIFY_UNSUPPORTED_HOST` before any check, `CERTIFY_REPORT_WRITE_FAILED` when the report
   file cannot be created, else `CERTIFY_UNAVAILABLE`. A usage error prints `CLI_INPUT_INVALID` with the usage line.

The exact commands, with Node 24 (the version CI tests). `<repo>` is a checkout of the commit under test.

```bash
# Linux x64, macOS x64 or arm64
mkdir -p "$HOME/moe-certify" && cd "$HOME/moe-certify"
node <repo>/scripts/local-runner/cli.mjs prerequisites --cache-dir "$HOME/moe-certify/images"
node <repo>/scripts/local-runner/cli.mjs certify --work-dir "$HOME/moe-certify"
```

```powershell
# Windows x64
New-Item -ItemType Directory -Force C:\moe-certify | Out-Null; Set-Location C:\moe-certify
node <repo>\scripts\local-runner\cli.mjs prerequisites --cache-dir C:\moe-certify\images
node <repo>\scripts\local-runner\cli.mjs certify --work-dir C:\moe-certify
```

**Resources and duration.** A run launches nine VMs: the certify VM, three for `check-containment`, one each for
`cancellation` and `recovery`, and three for `canary-check`. Two run at once, each with 2 CPUs, 4 GiB of memory and a
20 GiB disk, so the host needs room for twice that. Readiness waits up to 15 minutes for each VM. No duration has been
measured yet; each report's `startedAt` and `finishedAt` record its own.

**Network.** The first run downloads the pinned image (about 600 MB, from cloud-images.ubuntu.com), the pinned Node
toolchain (nodejs.org) and one registry tarball, `is-number@7.0.0` (registry.npmjs.org). They stay in `<work-dir>/images`
and are re-verified against their pins on every use. The altered-integrity canary run downloads the tarball again on
every run, on purpose. A network failure fails closed (for example `CERTIFY_CANARY_NOT_PASSED`); re-run certify.

**Windows image.** Multipass 1.17.0+win cannot launch a local image file. Its client sends `file://C:/…`, which the
daemon refuses because it reads `C:` as a host (canonical/multipass#5490), and `file:///C:/…` gains the current drive
(`file://D:/C:/…` from `D:`). A UNC path imports, but `hcs` converts it in place into a sparse VHDX that it cannot resize,
`0xC03A001A` (#5491). So on Windows Moe still downloads and checks its own copy in `<work-dir>/images` first, then
launches `release:<pin sha256>`. Multipass takes that exact image from its official Ubuntu release stream and checks the
download's sha256 before using it. Moe then refuses the guest with `IMAGE_PROVIDER_HASH_MISMATCH` unless `multipass info`
reports the pin as `image_hash`. The host needs HTTPS to cloud-images.ubuntu.com, and the first launch downloads the
621 MB image again, inside the launch's 15-minute window.

**Cleanup.** Certify deletes every VM it launches by exact owned name, and a check that cannot fails with its
`*_VM_NOT_DELETED` code. An interrupted run can leave a `moe-vm-<20 hex>` VM, recorded in `<work-dir>/ledger/<name>.json`.
Delete exactly that name with `multipass delete --purge <name>`, never `multipass delete --all` or `multipass purge`,
which are global. Remove the work dir once `multipass list` shows none of the run's VMs, keeping the report.

## The report

`<work-dir>/certification-<platform>-<arch>-<YYYYMMDDTHHMMSSZ>-<6 hex>.json`: one JSON line, created exclusively (it
never overwrites) with mode 0600.

| Field | Value |
|---|---|
| `kind`, `version` | `'isolation-certification'`, `1` |
| `platform`, `arch` | `'win32'`, `'linux'` or `'darwin'`; the image arch `'x64'` or `'arm64'`, or `null` |
| `transport` | `'native'` for the CLI run, `'injected'` for tests |
| `provider` | `{ name: 'multipass', version }`, the version the provider doctor read, or `null` |
| `image` | `{ sourceSha256, providerImageHash }`: the pinned image's sha256 and Multipass's id of the prepared image; on Windows both values are the pin |
| `supervisorSha256` | The sha256 of the `guest-supervisor.py` bytes the run installed |
| `startedAt`, `finishedAt` | ISO-8601 UTC |
| `checks` | The checks above, in order, each `{ id, result: 'passed' \| 'failed' \| 'not-run', code }`, with a code only on `'failed'` |
| `certified` | `true` only for a native run in which every check passed |
| `executionReady` | Always `false` |

`validateCertificationReport` (exported by `certify.mjs`) returns a deep-frozen copy only of a value with exactly these
keys, the current checks in order, `not-run` exactly after the first failure, `arch` and the three hashes `null` only on
an uncertified report, and `certified` true exactly for a native all-passed run. Anything else throws
`CERTIFY_REPORT_INVALID`. It checks shape only: it cannot tell a real run's report from a hand-written one, so each
recorded report rests on the operator who ran it. From the repository root:

```bash
node --input-type=module -e "import { readFileSync } from 'node:fs'; import { validateCertificationReport } from './scripts/local-runner/certify.mjs'; const r = validateCertificationReport(JSON.parse(readFileSync(process.argv[1], 'utf8'))); console.log(r.platform, r.arch, r.transport, r.certified, r.supervisorSha256);" <report.json>
```

CQ-R13 records a platform as certified only when:
- `validateCertificationReport` accepts the report, `transport` is `'native'` and `certified` is `true`;
- `supervisorSha256` equals the sha256 of `scripts/local-runner/guest-supervisor.py` at the commit under test;
- the reports together cover `win32`, `linux` and `darwin`.

## Certified platforms

A host with no recorded report is unsupported. Each recorded report follows the table verbatim.

| Platform | Arch | Multipass | Image sha256 | Supervisor sha256 | Finished | Report sha256 |
|---|---|---|---|---|---|---|
| `win32` | `x64` | unsupported: no report | | | | |
| `linux` | `x64` | unsupported: no report | | | | |
| `darwin` | `x64` | unsupported: no report | | | | |
| `darwin` | `arm64` | unsupported: no report | | | | |
