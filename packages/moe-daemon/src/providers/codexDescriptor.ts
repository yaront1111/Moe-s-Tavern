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

/**
 * The four launch invocations, verbatim. These are the strongest evidence the
 * scripts can give without a print-argv mode: each one is a whole command line,
 * so dropping a single token from one mode breaks its literal. The bash pair is
 * written with its line continuations already joined, which is how the contract
 * test views moe-agent.sh.
 */
const BASH_LAUNCH_INTERACTIVE =
  '"$COMMAND_BIN" "${COMMAND_ARGV[@]}" -c "model_instructions_file=$CODEX_SEAT_INSTRUCTIONS_FILE" -c "mcp_servers.moe.env.MOE_WORKER_ID=$WORKER_ID" -C "$PROJECT" "$SHORT_PROMPT"';
const BASH_LAUNCH_EXEC =
  '"$COMMAND_BIN" "${COMMAND_ARGV[@]}" -c "model_instructions_file=$CODEX_SEAT_INSTRUCTIONS_FILE" -c "mcp_servers.moe.env.MOE_WORKER_ID=$WORKER_ID" "${CODEX_EXEC_OVERRIDES[@]}" exec -C "$PROJECT" "${CODEX_SANDBOX_ARGS[@]}" "$SHORT_PROMPT"';
const PS_LAUNCH_INTERACTIVE = '& $Command @CommandArgs @codexSeatArgs -C "$projectPath" "$shortPrompt"';
const PS_LAUNCH_EXEC =
  '& $Command @CommandArgs @codexSeatArgs @codexExecOverrides exec -C "$projectPath" @codexSandboxArgs "$shortPrompt"';
/** PowerShell builds the per-seat overrides once and splats them into both launches. */
const PS_SEAT_ARG_WORKER_ID = '$codexSeatArgs += @(\'-c\', "mcp_servers.moe.env.MOE_WORKER_ID=$WorkerId")';
const PS_SEAT_ARG_INSTRUCTIONS = "$codexSeatArgs += @('-c', \"model_instructions_file=$($script:CodexSeatInstructionsFile.Replace('\\', '/'))\")";

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
        emitterEvidence: { bash: [BASH_LAUNCH_INTERACTIVE], powershell: [PS_LAUNCH_INTERACTIVE] },
      },
      'exec-headless': {
        agreement: 'shared',
        // `[--sandbox <mode>]` is the scripts' own notation: MOE_CODEX_SANDBOX=inherit omits the flag.
        value: ['-c', 'model_instructions_file=<seat file>', '-c', 'mcp_servers.moe.env.MOE_WORKER_ID=<workerId>', '-c', 'approvals_reviewer=user', 'exec', '-C', '<project>', '[--sandbox <mode>]', '<prompt>'],
        presentInBoth: ['approvals_reviewer=user', 'exec -C', '--sandbox'],
        emitterEvidence: { bash: [BASH_LAUNCH_EXEC], powershell: [PS_LAUNCH_EXEC] },
      },
    },
    perSeatOverrides: [
      {
        agreement: 'divergent',
        bash: '-c model_instructions_file=$CODEX_SEAT_INSTRUCTIONS_FILE (raw path, always emitted)',
        powershell: '-c model_instructions_file=<path, backslashes replaced by forward slashes> (emitted only when the seat-file variable is set)',
        onlyInBash: ['model_instructions_file=$CODEX_SEAT_INSTRUCTIONS_FILE'],
        onlyInPowershell: [PS_SEAT_ARG_INSTRUCTIONS, 'if ($script:CodexSeatInstructionsFile) {'],
        divergenceReason:
          'Same flag, different value and different emission rule: PowerShell forward-slashes the path and emits the override conditionally, bash passes it verbatim and unconditionally.',
      },
      {
        agreement: 'shared',
        value: '-c mcp_servers.moe.env.MOE_WORKER_ID=<workerId>',
        presentInBoth: ['mcp_servers.moe.env.MOE_WORKER_ID='],
        // bash repeats the override inline at each launch, so both modes are
        // pinned separately; PowerShell appends it once to the splatted array.
        emitterEvidence: { bash: [BASH_LAUNCH_INTERACTIVE, BASH_LAUNCH_EXEC], powershell: [PS_SEAT_ARG_WORKER_ID] },
      },
      {
        agreement: 'shared',
        value: '-c approvals_reviewer=user (exec mode only)',
        presentInBoth: ['approvals_reviewer=user'],
        emitterEvidence: {
          bash: ['CODEX_EXEC_OVERRIDES=(-c approvals_reviewer=user)'],
          powershell: ["$codexExecOverrides = @('-c', 'approvals_reviewer=user')"],
        },
      },
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
    pathFragments: {
      agreement: 'shared',
      value: ['.codex', 'config.toml'],
      presentInBoth: ['.codex', 'config.toml'],
      emitterEvidence: {
        bash: ['CODEX_CONFIG_DIR="$PROJECT/.codex"', 'CODEX_CONFIG_FILE="$CODEX_CONFIG_DIR/config.toml"'],
        powershell: ['$codexConfigDir = Join-Path $projectPath ".codex"', '$codexConfigFile = Join-Path $codexConfigDir "config.toml"'],
      },
    },
    topLevelKeys: [
      {
        agreement: 'shared',
        value: 'model_instructions_file = "agent-instructions.md"',
        presentInBoth: ['model_instructions_file = "agent-instructions.md"'],
        emitterEvidence: {
          // The bare key also occurs in each wrapper's merge filter, which strips
          // the previous run's line; only the emitter carries these forms.
          bash: ['\'model_instructions_file = "agent-instructions.md"\','],
          powershell: ['$topLevelConfig = @"\nmodel_instructions_file = "agent-instructions.md"'],
        },
      },
      {
        agreement: 'shared',
        value: 'model_reasoning_effort',
        presentInBoth: ['model_reasoning_effort'],
        emitterEvidence: {
          bash: ["'model_reasoning_effort = ' + json.dumps(reasoning_effort),"],
          powershell: ['model_reasoning_effort = "$codexReasoningEffort"'],
        },
      },
      {
        agreement: 'divergent',
        bash: 'developer_instructions = """<the sentence on one line>"""',
        powershell: 'developer_instructions = """<newline><the sentence><newline>"""',
        onlyInBash: ['developer_instructions = """You are a '],
        onlyInPowershell: ['developer_instructions = """`n'],
        divergenceReason:
          'Same key and same sentence, different bytes: the PowerShell here-string wraps the value in literal newlines. Harmless today, but it means the config the two wrappers write is not byte-identical.',
      },
      {
        // Both wrappers emit the same two-entry list into a FRESH config. The
        // merge fix-up applied to an EXISTING config is what diverges, so this
        // is a divergent fact even though the key and the target value match --
        // the same keys-match/values-drift trap as the TOML encoding entry below.
        agreement: 'divergent',
        bash: 'fresh config gets ["CLAUDE.md", ".codex/agent-instructions.md"]; on merge, ONLY the exact string project_doc_fallback_filenames = ["CLAUDE.md"] is rewritten',
        powershell: 'fresh config gets the same list; on merge, a regex rewrites ANY list containing "CLAUDE.md"',
        onlyInBash: ['\'project_doc_fallback_filenames = ["CLAUDE.md"]\',', 'content_str = content_str.replace('],
        onlyInPowershell: ['(project_doc_fallback_filenames\\s*=\\s*\\[.*?)"CLAUDE\\.md"(.*?\\])'],
        divergenceReason:
          'Simulated over three existing configs. On the canonical project_doc_fallback_filenames = ["CLAUDE.md"] the two agree. On ["CLAUDE.md", "AGENTS.md"] and on a no-space project_doc_fallback_filenames=["CLAUDE.md"], PowerShell adds .codex/agent-instructions.md to both while bash matches neither and leaves them untouched -- so on any config not written in exactly the canonical form, a codex seat launched by the bash wrapper never picks up the agent instructions doc while its PowerShell twin does.',
      },
    ],
    tables: [
      {
        agreement: 'shared',
        value: '[mcp_servers.moe]',
        presentInBoth: ['[mcp_servers.moe]'],
        // The bash merge filter repeats every table name as a startswith()
        // argument IN THE SAME BRANCH, so only the quoted-with-comma emitter
        // form pins it there. PowerShell's filter uses escaped regexes, so its
        // bare header is already emitter-unique.
        emitterEvidence: { bash: ['"[mcp_servers.moe]",'], powershell: ['[mcp_servers.moe]'] },
      },
      {
        agreement: 'shared',
        value: '[mcp_servers.moe.env]',
        presentInBoth: ['[mcp_servers.moe.env]'],
        emitterEvidence: { bash: ['"[mcp_servers.moe.env]",'], powershell: ['[mcp_servers.moe.env]'] },
      },
      {
        agreement: 'shared',
        value: '[mcp_servers.serena]',
        presentInBoth: ['[mcp_servers.serena]'],
        emitterEvidence: { bash: ['"[mcp_servers.serena]",'], powershell: ['[mcp_servers.serena]'] },
      },
    ],
    values: [
      {
        agreement: 'shared',
        value: 'startup_timeout_sec, default 120',
        presentInBoth: ['startup_timeout_sec', 'MOE_CODEX_MCP_STARTUP_TIMEOUT_SEC'],
        // bash names a python variable startup_timeout_sec one line above the
        // append, so the bare key survives deleting the emitter.
        emitterEvidence: {
          bash: ["moe_block_lines.append('startup_timeout_sec = %d' % startup_timeout_sec)"],
          powershell: ['startup_timeout_sec = $codexMcpStartupTimeout'],
        },
      },
      {
        agreement: 'shared',
        value: 'default_tools_approval_mode = "approve" on both servers',
        presentInBoth: ['default_tools_approval_mode = "approve"'],
        // Two emission sites per wrapper (the moe server and the serena server);
        // each literal below pins exactly one of them.
        emitterEvidence: {
          bash: ['moe_block_lines.append(\'default_tools_approval_mode = "approve"\')', '\'default_tools_approval_mode = "approve"\','],
          powershell: [
            'startup_timeout_sec = $codexMcpStartupTimeout\ndefault_tools_approval_mode = "approve"',
            '"--enable-gui-log-window", "false"]\ndefault_tools_approval_mode = "approve"',
          ],
        },
      },
      {
        agreement: 'shared',
        value: 'serena argv, headless and pinned to the project',
        presentInBoth: ['"start-mcp-server", "--context", "codex", "--project"'],
        emitterEvidence: {
          bash: ['\'args = \' + json.dumps(["start-mcp-server", "--context", "codex", "--project", serena_project,'],
          powershell: ['args = ["start-mcp-server", "--context", "codex", "--project", "$serenaProjectForToml", "--enable-web-dashboard", "false", "--enable-gui-log-window", "false"]'],
        },
      },
      {
        agreement: 'shared',
        value: 'model_reasoning_effort default xhigh',
        presentInBoth: ['MOE_CODEX_REASONING_EFFORT', 'xhigh'],
        emitterEvidence: {
          bash: ['"${MOE_CODEX_REASONING_EFFORT:-xhigh}"', 'reasoning_effort = sys.argv[8] if len(sys.argv) > 8 else "xhigh"'],
          powershell: ['$codexReasoningEffort = if ($env:MOE_CODEX_REASONING_EFFORT) { $env:MOE_CODEX_REASONING_EFFORT } else { "xhigh" }'],
        },
      },
      {
        agreement: 'divergent',
        // Not "every string value": developer_instructions interpolates the role
        // into the bash here-doc raw (it is validated against a fixed set at
        // parse time, so it is not operator-controlled at this point).
        bash: 'every operator-controlled TOML string value is escaped through json.dumps',
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
      {
        agreement: 'shared',
        value: 'MOE_PROJECT_PATH, written into [mcp_servers.moe.env] by the config writer',
        presentInBoth: ['MOE_PROJECT_PATH'],
        emitterEvidence: {
          bash: ["'MOE_PROJECT_PATH = ' + json.dumps(project_path),"],
          powershell: ['MOE_PROJECT_PATH = "$projectPathForToml"$moeDaemonHostLine'],
        },
      },
      {
        agreement: 'shared',
        // Reaches the same table, but never through the file: the config is
        // shared by every seat on the project, so the workerId rides argv.
        value: 'MOE_WORKER_ID, delivered per seat on argv as -c mcp_servers.moe.env.MOE_WORKER_ID=<workerId>, never written into the config file',
        presentInBoth: ['mcp_servers.moe.env.MOE_WORKER_ID='],
        emitterEvidence: { bash: [BASH_LAUNCH_INTERACTIVE, BASH_LAUNCH_EXEC], powershell: [PS_SEAT_ARG_WORKER_ID] },
      },
      {
        agreement: 'shared',
        value: 'MOE_DAEMON_HOST, written only when it is already set in the environment',
        presentInBoth: ['MOE_DAEMON_HOST'],
        emitterEvidence: {
          bash: ['moe_block_lines.append(\'MOE_DAEMON_HOST = \' + json.dumps(os.environ["MOE_DAEMON_HOST"]))'],
          powershell: ['$moeDaemonHostLine = if ($env:MOE_DAEMON_HOST) {'],
        },
      },
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
      onlyInBash: ['TOML_PROXY_CMD', "'command = ' + json.dumps(proxy_cmd),", "moe_block_lines.append('args = ' + json.dumps([proxy_args]))"],
      onlyInPowershell: ['command = "node"', 'args = ["$proxyScriptForToml"]'],
      divergenceReason:
        'The bash writer resolves the proxy command; the PowerShell writer hardcodes node. The two wrappers can emit structurally different [mcp_servers.moe] blocks for the same project.',
    },
    daemonHostUpsert: {
      agreement: 'divergent',
      bash: 'discovers a daemon host across the WSL boundary and, after discovery, upserts MOE_DAEMON_HOST into [mcp_servers.moe.env] so the written config stays self-contained',
      powershell: 'no discovery step and no upsert; MOE_DAEMON_HOST reaches the file only when it is already set in the environment at writer time',
      onlyInBash: ['DAEMON_HOST_TOML_FILE'],
      onlyInPowershell: ['$moeDaemonHostLine'],
      divergenceReason:
        'A FEATURE ASYMMETRY, not a latent PowerShell bug -- checked, because the first transcription got this wrong. moe-agent.ps1 never assigns MOE_DAEMON_HOST; it only reads it (once for codex, once for grok). The only discovery anywhere is the bash cross-boundary probe, which exports the candidate it reaches, and the upsert exists to persist exactly that. A PowerShell run that discovers a host at probe time cannot happen. Both wrappers do write a PRE-SET host, identically. So there is no winner to pick here -- but a registry would still have to model "this launcher has a step the other does not", which no single value can express.',
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
      // Transcribed from the code, NOT from the comment above it. The comment at
      // the rm -f site claims the EXIT trap also removes the secure temp
      // directory; it does not. create_secure_temp is only ever called inside
      // $(...), so SECURE_TEMP_DIR never reaches the parent shell and
      // cleanup_temp's rm -rf is a no-op against an empty path. Fixing that leak
      // is out of scope here (it would edit a launcher); recording what the code
      // does rather than what it claims is the point.
      bash: 'the seat file is removed by an explicit rm -f after the CLI returns; the enclosing mktemp directory is NOT removed, despite the comment claiming the EXIT trap gets it',
      powershell: 'left in TEMP; no per-iteration removal',
      onlyInBash: ['rm -f "$CODEX_SEAT_INSTRUCTIONS_FILE"'],
      onlyInPowershell: ['$script:CodexSeatInstructionsFile = Join-Path'],
      divergenceReason:
        'Only the bash wrapper deletes the seat context file between iterations, so a long-running PowerShell wrapper leaves prior task context on disk. Neither wrapper cleans up the directory it wrote the file into.',
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
          // The probe is the THIRD site carrying the per-seat -c overrides in
          // bash (the two launches are the others); pin it so a change there
          // cannot slip past the per-mode launch literals.
          emitterEvidence: {
            bash: ['-c "mcp_servers.moe.env.MOE_WORKER_ID=$WORKER_ID" "${CODEX_EXEC_OVERRIDES[@]}" exec -C "$PROJECT" "${CODEX_SANDBOX_ARGS[@]}" --help 2>&1'],
            powershell: ['(& $Command @CommandArgs @codexSeatArgs @codexExecOverrides exec -C "$projectPath" @codexSandboxArgs --help 2>&1 | Out-String)'],
          },
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
