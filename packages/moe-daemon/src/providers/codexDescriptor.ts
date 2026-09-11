/**
 * codex, transcribed 2026-09-11 from scripts/moe-agent.sh (6141 lines) and
 * scripts/moe-agent.ps1 (5214 lines). PURE DATA -- see providerDescriptor.ts
 * for why this is a spike artifact, why its location is provisional, and why
 * nothing in the daemon may import it.
 *
 * Exactly ONE provider is covered on purpose. Whether to transcribe a second is
 * precisely what docs/plans/2026-09-11-provider-registry-spike.md recommends or
 * rejects; doing it here would pre-empt that decision.
 *
 * Every value below is what the scripts BUILD today, not what they ought to
 * build. Where a facet has no answer for codex it carries an explicit
 * `unsupported` marker naming the reason -- never a blank and never a plausible
 * invention, either of which would corrupt the finding.
 */
import type { ProviderDescriptor } from './providerDescriptor.js';

export const CODEX_DESCRIPTOR: ProviderDescriptor = {
  providerId: 'codex',
  cliTypeToken: { agreement: 'shared', value: 'codex', presentInBoth: ['"codex"'] },

  sessionMode: {
    defaultModeId: 'interactive-tui',
    defaultPolicy: {
      agreement: 'shared',
      value: 'interactive TUI for every role; headless is opt-in per seat',
      presentInBoth: ['Interactive mode: polling disabled'],
    },
    modes: [
      {
        id: 'interactive-tui',
        isDefault: true,
        holdsTerminal: true,
        optIn: null,
        banner: {
          agreement: 'divergent',
          bash: 'Starting Codex (interactive TUI)...',
          powershell: 'Codex mode: interactive TUI',
          onlyInBash: ['Starting Codex (interactive TUI)...'],
          onlyInPowershell: ['Codex mode: interactive TUI'],
          divergenceReason:
            'The launch banners were never unified, and parity-check.sh does not pin them, so an operator greps a different string depending on which wrapper ran.',
        },
      },
      {
        id: 'exec-headless',
        isDefault: false,
        holdsTerminal: false,
        optIn: {
          agreement: 'divergent',
          bash: '--codex-exec',
          powershell: '-CodexExec',
          onlyInBash: ['--codex-exec'],
          onlyInPowershell: ['$CodexExec'],
          divergenceReason:
            'Flag spelling follows each host shell: a getopts long flag vs a PowerShell [switch]. Each wrapper names the twin spelling in a COMMENT, so the asymmetry only holds against a comment-stripped view.',
        },
        banner: {
          agreement: 'divergent',
          bash: 'Starting Codex (exec, headless)...',
          powershell: 'Codex mode: exec (non-interactive, headless)',
          onlyInBash: ['Starting Codex (exec, headless)...'],
          onlyInPowershell: ['Codex mode: exec (non-interactive, headless)'],
          divergenceReason: 'Same unresolved banner split as the interactive mode.',
        },
      },
    ],
  },

  argv: {
    // Shared at the TOKEN level only. The VALUES diverge: see perSeatOverrides[0]
    // (the seat-file path and whether PowerShell emits it at all) and
    // terminalHandoff.argvQuoteGuard (PowerShell can rewrite the prompt bytes).
    tokensByMode: {
      'interactive-tui': {
        agreement: 'shared',
        value: ['-c', 'model_instructions_file=<seat file>', '-c', 'mcp_servers.moe.env.MOE_WORKER_ID=<workerId>', '-C', '<project>', '<prompt>'],
        presentInBoth: ['model_instructions_file=', 'mcp_servers.moe.env.MOE_WORKER_ID='],
      },
      'exec-headless': {
        agreement: 'shared',
        // `[--sandbox <mode>]` is the scripts' own notation: MOE_CODEX_SANDBOX=inherit omits the flag.
        value: ['-c', 'model_instructions_file=<seat file>', '-c', 'mcp_servers.moe.env.MOE_WORKER_ID=<workerId>', '-c', 'approvals_reviewer=user', 'exec', '-C', '<project>', '[--sandbox <mode>]', '<prompt>'],
        presentInBoth: ['approvals_reviewer=user', 'exec -C', '--sandbox'],
      },
    },
    perSeatOverrides: [
      {
        agreement: 'divergent',
        bash: '-c model_instructions_file=$CODEX_SEAT_INSTRUCTIONS_FILE (raw path, always emitted)',
        powershell: '-c model_instructions_file=<path, backslashes replaced by forward slashes> (emitted only when the seat-file variable is set)',
        onlyInBash: ['model_instructions_file=$CODEX_SEAT_INSTRUCTIONS_FILE'],
        onlyInPowershell: ["CodexSeatInstructionsFile.Replace('\\', '/')", 'if ($script:CodexSeatInstructionsFile) {'],
        divergenceReason:
          'Same flag, different value and different emission rule: PowerShell forward-slashes the path and emits the override conditionally, bash passes it verbatim and unconditionally.',
      },
      { agreement: 'shared', value: '-c mcp_servers.moe.env.MOE_WORKER_ID=<workerId>', presentInBoth: ['mcp_servers.moe.env.MOE_WORKER_ID='] },
      { agreement: 'shared', value: '-c approvals_reviewer=user (exec mode only)', presentInBoth: ['approvals_reviewer=user'] },
    ],
    forbiddenTokens: [
      {
        token: '--full-auto',
        reason:
          'codex-cli 0.147+ rejects it with exit 2 before any work, and the launch-failure backoff then relaunches forever. parity-check.sh already guards its reintroduction; this pins the same fact in the descriptor.',
      },
    ],
    sandbox: {
      envVar: { agreement: 'shared', value: 'MOE_CODEX_SANDBOX', presentInBoth: ['MOE_CODEX_SANDBOX'] },
      defaultMode: { agreement: 'shared', value: 'danger-full-access', presentInBoth: ['danger-full-access'] },
      modes: {
        agreement: 'shared',
        value: ['read-only', 'workspace-write', 'danger-full-access', 'inherit'],
        presentInBoth: ['read-only', 'workspace-write', 'danger-full-access', 'inherit'],
      },
      invalidWarning: {
        agreement: 'shared',
        value: 'an unrecognised value falls back to danger-full-access with a [WARN]',
        presentInBoth: ['is not one of read-only | workspace-write | danger-full-access | inherit; using danger-full-access.'],
      },
    },
    promptDelivery: {
      agreement: 'shared',
      value: 'a positional argv string; per-iteration context travels in the seat instructions file, not on argv',
      presentInBoth: ['Session context (routed mentions, pre-flight data) is in '],
    },
  },

  config: {
    format: 'toml',
    pathFragments: { agreement: 'shared', value: ['.codex', 'config.toml'], presentInBoth: ['.codex', 'config.toml'] },
    topLevelKeys: [
      { agreement: 'shared', value: 'model_instructions_file = "agent-instructions.md"', presentInBoth: ['model_instructions_file = "agent-instructions.md"'] },
      { agreement: 'shared', value: 'model_reasoning_effort', presentInBoth: ['model_reasoning_effort'] },
      {
        agreement: 'divergent',
        bash: 'developer_instructions = """<the sentence on one line>"""',
        powershell: 'developer_instructions = """<newline><the sentence><newline>"""',
        onlyInBash: ['developer_instructions = """You are a '],
        onlyInPowershell: ['developer_instructions = """`n'],
        divergenceReason:
          'Same key and same sentence, different bytes: the PowerShell here-string wraps the value in literal newlines. Harmless today, but it means the config the two wrappers write is not byte-identical.',
      },
      { agreement: 'shared', value: 'project_doc_fallback_filenames includes .codex/agent-instructions.md', presentInBoth: ['project_doc_fallback_filenames', '.codex/agent-instructions.md'] },
    ],
    tables: [
      { agreement: 'shared', value: '[mcp_servers.moe]', presentInBoth: ['[mcp_servers.moe]'] },
      { agreement: 'shared', value: '[mcp_servers.moe.env]', presentInBoth: ['[mcp_servers.moe.env]'] },
      { agreement: 'shared', value: '[mcp_servers.serena]', presentInBoth: ['[mcp_servers.serena]'] },
    ],
    values: [
      { agreement: 'shared', value: 'startup_timeout_sec, default 120', presentInBoth: ['startup_timeout_sec', 'MOE_CODEX_MCP_STARTUP_TIMEOUT_SEC'] },
      { agreement: 'shared', value: 'default_tools_approval_mode = "approve" on both servers', presentInBoth: ['default_tools_approval_mode = "approve"'] },
      { agreement: 'shared', value: 'serena argv, headless and pinned to the project', presentInBoth: ['"start-mcp-server", "--context", "codex", "--project"'] },
      { agreement: 'shared', value: 'model_reasoning_effort default xhigh', presentInBoth: ['MOE_CODEX_REASONING_EFFORT', 'xhigh'] },
      {
        agreement: 'divergent',
        bash: 'every TOML string value is escaped through json.dumps',
        powershell: 'values are interpolated raw into a here-string (paths are forward-slashed first)',
        onlyInBash: ["'model_reasoning_effort = ' + json.dumps(reasoning_effort)"],
        onlyInPowershell: ['model_reasoning_effort = "$codexReasoningEffort"'],
        divergenceReason:
          'A value containing a double quote or a backslash -- an operator-set MOE_CODEX_REASONING_EFFORT or MOE_DAEMON_HOST, say -- is escaped by the bash writer and written verbatim by the PowerShell one, which can produce invalid TOML. The keys match; the encoding does not.',
      },
      {
        agreement: 'divergent',
        bash: 'python int() on MOE_CODEX_MCP_STARTUP_TIMEOUT_SEC, 120 only on ValueError',
        powershell: 'accepted only if it matches ^\\d+$, else 120',
        onlyInBash: ['int(os.environ.get("MOE_CODEX_MCP_STARTUP_TIMEOUT_SEC", "120"))'],
        onlyInPowershell: ["$env:MOE_CODEX_MCP_STARTUP_TIMEOUT_SEC -match '^\\d+$'"],
        divergenceReason:
          'Same default, different validation: python int() accepts a negative or whitespace-padded value such as "-5" or " 42 ", which the PowerShell regex rejects in favour of 120. The same environment can therefore yield different startup_timeout_sec values.',
      },
    ],
    envKeys: [
      { agreement: 'shared', value: 'MOE_PROJECT_PATH', presentInBoth: ['MOE_PROJECT_PATH'] },
      { agreement: 'shared', value: 'MOE_WORKER_ID', presentInBoth: ['MOE_WORKER_ID'] },
      { agreement: 'shared', value: 'MOE_DAEMON_HOST', presentInBoth: ['MOE_DAEMON_HOST'] },
    ],
    ownedSections: {
      agreement: 'divergent',
      bash: ['[mcp_servers.moe]', '[mcp_servers.moe.env]', '[mcp_servers.serena]', '[mcp_servers.serena. (literal startswith, only when serena is absent)'],
      powershell: ['[mcp_servers.moe]', '[mcp_servers.moe.env]', '[mcp_servers.serena]', '^\\[mcp_servers\\.serena\\. (escaped regex, only when serena is absent)'],
      onlyInBash: ['[mcp_servers.serena.'],
      onlyInPowershell: ['^\\[mcp_servers\\.serena\\.'],
      divergenceReason:
        'The merge RULE is the same in both wrappers -- strip the three owned sections, and strip serena subtables only when serena is absent -- but it is expressed in two different string forms. Text presence can pin the section names; it cannot pin that the two matchers behave identically. That is a limitation of this whole approach, not of this entry.',
    },
    proxyCommand: {
      agreement: 'divergent',
      bash: 'command = the resolved node path or the proxy binary; the args line is OMITTED entirely when the proxy is a direct executable',
      powershell: 'command = "node" is hardcoded and args is always emitted',
      onlyInBash: ['TOML_PROXY_CMD'],
      onlyInPowershell: ['command = "node"'],
      divergenceReason:
        'The bash writer resolves the proxy command; the PowerShell writer hardcodes node. The two wrappers can emit structurally different [mcp_servers.moe] blocks for the same project.',
    },
    daemonHostUpsert: {
      agreement: 'divergent',
      bash: 'after daemon-host discovery, upserts MOE_DAEMON_HOST into [mcp_servers.moe.env] so the written config stays self-contained on WSL runs',
      powershell: 'no post-discovery upsert; only a pre-set MOE_DAEMON_HOST reaches the file',
      onlyInBash: ['DAEMON_HOST_TOML_FILE'],
      onlyInPowershell: ['$moeDaemonHostLine'],
      divergenceReason:
        'The TOML writer runs BEFORE daemon-host probing in both wrappers, but only the bash wrapper rewrites the file afterwards. A PowerShell run that discovers the host at probe time leaves it out of the config.',
    },
  },

  events: {
    toolEventStream: {
      agreement: 'unsupported',
      reason:
        'Neither wrapper requests or parses a machine-readable event stream from codex; whether codex itself could supply one is not established by this spike. The stream-json parser, MOE_TOOL_WRITES_FILE and the TOOL attribution tier are claude-only, so a codex seat can never reach the TOOL tier -- its paths are attributed ASSERTED, PLANNED or MEASURED only. No evidence literal is declared here on purpose: text presence cannot prove an absence.',
    },
    partialMessages: {
      agreement: 'unsupported',
      reason: 'No partial-message or progress channel is consumed for codex in either wrapper.',
    },
  },

  resume: {
    cliSessionResume: {
      agreement: 'unsupported',
      reason:
        'Neither wrapper passes any codex session-resume flag. Resume is wrapper-level only and provider-agnostic, so it is not a property of the provider at all.',
    },
    wrapperRelaunch: {
      agreement: 'shared',
      value:
        'claim_next_task returning hasNext:false with alreadyAssigned makes the wrapper relaunch a fresh CLI on the held task with a RESUME prompt, capped by MOE_RESUME_MAX_ATTEMPTS (default 5)',
      presentInBoth: ['MOE_RESUME_MAX_ATTEMPTS'],
    },
  },

  terminalHandoff: {
    pollingSuppressed: {
      agreement: 'shared',
      value: 'an interactive codex seat disables the polling loop, because the TUI is one long-lived REPL',
      presentInBoth: ['Interactive mode: polling disabled'],
    },
    seatInstructionsFile: {
      agreement: 'divergent',
      bash: 'a mode-restricted secure temp dir: moe-codex-instructions-<role>-<pid>.md',
      powershell: 'the plain user TEMP: moe-codex-instructions-<role>-<pid>.md',
      onlyInBash: ['create_secure_temp)/moe-codex-instructions-'],
      onlyInPowershell: ['Join-Path $env:TEMP "moe-codex-instructions-'],
      divergenceReason:
        'The bash wrapper puts the per-seat instructions -- which carry task JSON and routed chat text -- in a mode-restricted temp directory; the PowerShell wrapper writes them into the plain user TEMP.',
    },
    seatInstructionsCleanup: {
      agreement: 'divergent',
      bash: 'removed immediately after the CLI returns, and again by the EXIT trap',
      powershell: 'left in TEMP; no per-iteration removal',
      onlyInBash: ['rm -f "$CODEX_SEAT_INSTRUCTIONS_FILE"'],
      onlyInPowershell: ['$script:CodexSeatInstructionsFile = Join-Path'],
      divergenceReason:
        'Only the bash wrapper deletes the seat context file between iterations, so a long-running PowerShell wrapper leaves prior task context on disk.',
    },
    argvQuoteGuard: {
      agreement: 'divergent',
      bash: 'none needed -- a bash array passes argv without re-quoting',
      powershell: 'under PowerShell below 7.3 every double quote in the prompt is swapped for a single quote before launch',
      onlyInBash: ['${COMMAND_ARGV[@]}'],
      onlyInPowershell: ['-replace \'"\', "\'"'],
      divergenceReason:
        'PowerShell below 7.3 forwards native arguments without escaping embedded quotes, so the prompt would word-split and codex would parse a fragment as a subcommand. The guard MUTATES the prompt text, so the two wrappers can hand codex different prompt bytes for the same task.',
    },
  },

  failures: {
    classes: [
      {
        code: 'MOE_CLI_ARGV_REJECTED',
        terminal: true,
        detection: {
          agreement: 'shared',
          value: ['the real argv plus --help, probed once per wrapper process', 'a nonzero exit whose output matches the clap parse-error vocabulary'],
          presentInBoth: ['--help', 'unexpected argument|unrecognized subcommand|unexpected value'],
        },
        escalation: {
          agreement: 'shared',
          value: 'a #general @governors message, then the seat exits instead of relaunch-looping',
          presentInBoth: ["rejects the wrapper's launch argv"],
        },
      },
    ],
    missingBinary: { agreement: 'shared', value: 'codex not on PATH is a hard error before any launch', presentInBoth: ['Codex command not found:'] },
    disableProbe: { agreement: 'shared', value: 'MOE_DISABLE_ARGV_PROBE=1 skips the probe', presentInBoth: ['MOE_DISABLE_ARGV_PROBE'] },
  },
};
