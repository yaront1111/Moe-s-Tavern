# Protected profile threat model: trusting `.moe/daemon.json`

## Status

Decided 2026-10-30 by CQ-RF05 (task-b439d7fb, epic CQ-RF). This is the second decision on this question.
The first plan's premise check failed (task comment comment-4bef8984), and this record replaces that plan's
decision. A human may revise it.

It applies to the protected profile and its guest path. The IDE selects that profile for
`settings.executionProfile: verified-local`, and it also fails closed to it. Legacy behavior is unchanged.
Code references are as read on `moe/work-2026-10-24` on 2026-10-30. Line numbers drift; symbol names
are the stable reference.

## Threat model

Scope: Moe's host components and the guest path. The host components are the IDE's runtime selection and
daemon connection, the daemon's network surface, and the local runner.

In the model:
- Repository content, as data those components read: every byte a clone, pull, merge or checkout can
  place under the project, ignored runtime files included. `.moe/daemon.json` is gitignored
  (`.gitignore:63`), but Git still overwrites an ignored file when an upstream commit adds it, as
  comment-4bef8984 reproduced. So no host component may treat `.moe/daemon.json` as written by the daemon.
  The profile setting is repository content too. CQ-R01's session pin stops a downgrade through it within
  an IDE session, and CQ-RF02 (task-f3485ac9, not yet landed) makes that pin persistent. Both are outside
  this record.
- Code running in Moe-provisioned guests: agent and check jobs.
- Web pages in a local browser. A page can send HTTP requests and open WebSockets to a loopback port, and
  browsers apply no CORS to a WebSocket upgrade.
- Network peers: any host that can reach an interface the daemon listens on beyond loopback.

Out of the model:
- Same-user host processes. They can already change the user-writable installed plugin and runtime, node,
  the owner-only IDE state store (CQ-RF01), the runner key, and the IDE and daemon processes themselves
  (a debugger, ptrace or OpenProcess). This includes repository code that runs on the host: a build, a
  test, a Git hook, and whatever a host-launched agent seat runs. The protected profile contains
  repository code on the guest path only; host seats are outside it. One input to host seats is
  repository content: under the protected profile the IDE still passes the repository's
  `settings.agentCommand` to the wrapper as the command to run
  (`moe-jetbrains/src/main/kotlin/com/moe/util/TerminalAgentLauncher.kt:267-268`, resolveContext;
  `scripts/moe-agent.sh:366`, parse_command_into_argv). That is R01's known gap, outside this decision.
- Other local OS users. `/ws` and `/mcp` accept loopback clients without authentication
  (`packages/moe-daemon/src/server/WebSocketServer.ts:339`, onConnection). So a single-user host is
  assumed, and shared multi-user hosts are unsupported until those channels authenticate.
- Operator configuration. An explicit `--host` or `MOE_BIND_HOST` beyond loopback
  (`packages/moe-daemon/src/index.ts:64`) is the operator's choice to expose the daemon to that network.

## Open points

### 1. The daemon.json port↔pid binding (CQ-R01 follow-up 5)

The IDE reads `.moe/daemon.json` in `moe-jetbrains/src/main/kotlin/com/moe/services/MoeDaemonSupervisor.kt:47`
(readDaemonInfo). Under the protected profile, `MoeProjectService.doConnect`
(`services/MoeProjectService.kt:247-250`) first calls `activationRefusal` (`MoeDaemonSupervisor.kt:172`).
That runs `RuntimeSelectionPolicy.verifyProvenance` (`util/RuntimeSelectionPolicy.kt:281`), which checks
the file's pid against the IDE's own spawn records: the pid and its start instant, or a recorded
supervisor as its direct parent. The client then dials the file's port on 127.0.0.1
(`MoeProjectService.kt:264`). Nothing binds that port to the verified pid. The local runner dials the
file's port the same way (`scripts/local-runner/runner-client.mjs:107` for `/runner`,
`scripts/local-runner/vm-control.mjs:140` for `/mcp`).

So the listener on the port is never shown to be the verified process. Whatever listens there is a host
process:
- Repository content, as data, starts no listener.
- A guest's loopback belongs to its own VM. The host drives the guest's supervisor over the pinned OpenSSH
  client, with an argv built from constants that clears all forwardings
  (`scripts/local-runner/guest-ssh.mjs:119`, sshStreamArgv, spawned by
  `scripts/local-runner/guest-stream.mjs:19`). The guest's one authorized key carries `restrict` and a forced
  command that runs only the supervisor (`scripts/local-runner/guest-ssh.mjs:77`). Nothing in
  `scripts/local-runner` sets up a port forward, and R07's rule requires zero host mounts
  (`scripts/local-runner/snapshot-transfer.mjs:74`). CQ-R13e's `guest-network` certify check
  (`scripts/local-runner/certify-bridge.mjs:183`) shows on real hardware that no guest identity reaches the
  host's daemon ports; it passed in both reports recorded in `docs/CERTIFICATION.md` (linux x64, win32 x64).
- Browsers give a page no way to listen on a TCP port it chooses, and a network peer cannot open a
  listening socket on this host.

The pid and the port come from the same file, so a file that also names the live daemon's pid could point
the IDE's client at a different host listener, such as another project's daemon. The pid is assigned at
each spawn, so repository bytes written upstream can match it only by guessing. The one in-model
disclosure found while deciding is the `/health` read below (task-80930ce6). The listener reached is still
a host process the user runs. Likewise, the runner client presents the owner-only runner key to the
file's port; a listener there is a host process, and a same-user host process can already read that key.

Result: accepted and documented, with no code change.

### 2. The per-request daemon.json re-check (CQ-R08 handoff point 3)

`scripts/local-runner/guest-session.mjs:78` (daemonRefusal) re-reads the file before the spawn (`:66`)
and before every forward (`:173`; the forward itself is at `:181`). It admits an absent `bindHost` or a
literal loopback one (`:96`). `runner-client.mjs:50` (RUNNER_DAEMON_NOT_LOOPBACK) and
`vm-control.mjs:129` (readDaemonInfo) apply the same rule. The daemon writes the file once, at start
(`index.ts:773`), and records `bindHost` only when it is not the 127.0.0.1 default (`index.ts:769`).

The window between the check and the forward is not the gap; the check's input is. The bind comes from a
file that repository content can supply, and an absent `bindHost` reads as loopback. When the daemon
actually listens beyond loopback (WSL agent mode, below, or an operator's wide bind), that input can keep
the refusal from firing. Guest sessions would then run while `/ws` and `/mcp` may be reachable from the
guest network through a host interface. The Origin rule does not help there: a client that is not a
browser need not send an Origin, and an absent Origin is admitted (`WebSocketServer.ts:213`). None of
this needs a host process.

Once the check takes the bind from the daemon itself (task-2cf1c6be), what remains is a bind change during
a session. The bind is fixed for the daemon's life (`index.ts:608-609`, startDaemon), and the supervisor
restarts a crashed daemon with the same `--host` (`index.ts:892-893`). So only an operator action that
restarts the daemon (turning WSL agents on, Restart Daemon) or a host process can change it.

Result: the window is accepted; the input is not.

### Found while deciding

As of the commit read:
- **Origin:** the daemon now refuses every WebSocket upgrade that carries an Origin header, on every path
  (`WebSocketServer.ts:249`, verifyClient, calling verifyUpgradeOrigin at `:258`; the allow list at
  `:207` is empty). task-801272c4 has landed and is in review. Before it, a page in a local browser
  could open `/ws` and `/mcp`.
- **WSL agent mode** still listens on every interface under the protected profile:
  `MoeDaemonSupervisor.kt:230` (protectedDaemonCommand) appends `--host 0.0.0.0`, the legacy builders at
  `:331` and `:346` do the same, and `TerminalAgentLauncher.kt:191-198` documents why. Neither
  task-2f2484b4 (a 'wsl' bind: loopback plus the WSL adapter) nor task-0c72d59a (JetBrains passes
  `--host wsl`) has landed.
- **`/health`:** plain HTTP `/health` (`index.ts:669`) answers any Host header with the daemon's pid and
  project path, so a DNS-rebinding page can read it. The Origin rule covers WebSocket upgrades only.
  Filed as task-80930ce6.
- **`/runner`** stays closed under a wide bind: `packages/moe-daemon/src/server/runnerChannel.ts:97`
  (authenticateRunner) admits only a loopback peer (`:86` isLoopback, checked at `:99`) that presents the
  owner-only key (`:104-106`).

## Options considered

### For the port↔pid binding

- **Per-platform OS lookup of the port's owner: rejected.** Neither the JDK nor Node has an API for it.
  Windows needs GetExtendedTcpTable, a native call. Linux needs `/proc/net/tcp` plus a scan of each
  process's file descriptors, which cannot see other users' processes. macOS needs libproc or `lsof`. So
  it takes native code or external tools, while the protected selection resolves node in-process instead
  of running `where` or `which` by bare name, and drops project PATH entries
  (`MoeDaemonSupervisor.kt:262-263`, nodeOnProtectedPath). It is brittle, and the only listeners it
  would rule out are host processes, which are out of the model.
- **A daemon-issued nonce, checked over `/health` or the `/ws` handshake: deferred.** The IDE would
  generate it at spawn, pass it through the daemon's environment, keep it in the CQ-RF01 store, and check
  a challenge-response. It is the right mechanism once other local users are in the model, and it would
  also close the redirect case in open point 1. Alone, though, it changes nothing for other users while
  `/ws` and `/mcp` stay open to them, and the redirect case needs a live pid that repository bytes can
  match only by guessing.
- **An owner-only daemon record outside the repository, next to the runner key** (`runnerChannel.ts:42`,
  runnerKeyPath): **deferred** with the nonce, for the same reasons.
- **Accept and document the gap: chosen.**

### For the per-request re-check

Options (a) to (d) are the ones comment-4bef8984 lists.
- **(a) Refuse guest sessions when the IDE started the daemon with `--host`: rejected.** The local runner
  is not the IDE and has no channel to its spawn records. The IDE's argv also misses a `MOE_BIND_HOST`
  bind and any daemon the IDE did not start.
- **(b) Take the bind from the daemon itself: chosen, as task-2cf1c6be.** The source is the daemon's
  loopback `/health` report matched on this project, or an owner-only record outside the repository.
  `/health` reports no bind today (`index.ts:669`), so that row adds it. A loopback answer comes from a
  host process (open point 1), the project match rules out another project's daemon, and no matching
  answer must refuse. This is not provenance: which binary runs stays with R01's spawn records.
- **(c) Forbid any bind beyond loopback under the protected profile: not chosen.** The 'wsl' bind rows
  remove the every-interface exposure, and a trusted check keeps guest sessions off whenever the bind is
  not loopback. Forbidding the wide bind would drop a supported configuration (WSL agents) only to close
  the operator-action window.
- **(d) Keep the first decision and document a WSL exception: rejected**, because it accepts an in-model
  attacker chain.
- **Accept the window itself: chosen**, once (b) lands.

## Decision

1. Same-user host processes stay outside the protected profile's threat model, and so do other local OS
   users. A single-user host is assumed. Host-launched agent seats are outside the profile's containment.
2. Repository content (ignored `.moe/` runtime files included), guest code, browser pages and network
   peers are inside it.
3. On the live daemon's identity, bind and reachability, a file under the project, `.moe/daemon.json`
   included, may add a refusal but never an admission. Trust in the live daemon comes from the daemon
   itself, or from owner-only state outside the repository. In the IDE's connection and the local runner,
   open point 1 is the one accepted exception: the IDE admits only a pid its own spawn records verify,
   then dials the file's port. Host seats do not meet this rule yet: they read the file too (the proxy
   and the wrappers), and they run `settings.agentCommand` (above). They are outside this decision.
4. Open point 1 is accepted and documented, with no code change.
5. Open point 2: the window is accepted, and the check's input moves to the daemon (task-2cf1c6be). That
   row must land before verified-local is enabled. Whether it also gates CQ-R13 certification is a human
   call.
6. Under the protected profile, guest sessions and a bind beyond loopback are mutually exclusive:
   guest-session refuses every non-loopback bind, 'wsl' included. `guest-session.mjs:96` already refuses
   any non-loopback value in the file, and task-2cf1c6be makes that value trustworthy. A guest-to-daemon
   certification (CQ-R13e) applies to a loopback-only daemon.

## Follow-up rows

- **Required, new:** task-2cf1c6be (epic Stability & Hardening, MEDIUM). The local runner's loopback
  checks take the bind from the daemon. It must land before verified-local is enabled.
- **Required, already filed from the same finding:** task-724e31fa (HIGH), with its slices task-801272c4
  (the Origin rule; landed, in review), task-2f2484b4 (the 'wsl' bind) and task-0c72d59a (JetBrains
  passes `--host wsl`).
- **Required, filed while writing this record:** task-80930ce6 (LOW). `/health` checks the Host header,
  because browser pages are in the model.
- **Not required; for multi-user hosts:** authenticate `/ws` and `/mcp`, and bind daemon.json to its
  daemon with the spawn nonce or the owner-only record.
- **Outside this decision:** host seats under the protected profile, including `settings.agentCommand`.
  The planning architect flagged this to the governor on 2026-10-30.
- **Revisit this record if** CQ-R13e's guest network probe fails, verified-local is enabled before
  task-2cf1c6be lands, guest sessions are ever allowed with a bind beyond loopback, or other local users
  or shared hosts come into scope.
- **Rows that should cite this record:** CQ-RF06 (task-98ffe33f) and CQ-RF06b (task-032c9739) for VS
  Code parity, and CQ-RF07 (task-f3f364a6) for integration.
