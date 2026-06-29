# ROS 2 Skill: Diagnostics & Verification Rules

> **This file is part of a split rule set.** The full rule set spans five files:
> - [RULES-CORE.md](RULES-CORE.md) — general agent conduct, applies to every command
> - [RULES-PREFLIGHT.md](RULES-PREFLIGHT.md) — before every action: introspection, session-start, hardware readiness
> - [RULES-MOTION.md](RULES-MOTION.md) — motion workflow: discover → execute → estop → verify
> - **RULES-DIAGNOSTICS.md** ← you are here — when things go wrong: diagnose, verify, escalate
> - [RULES-REFERENCE.md](RULES-REFERENCE.md) — lookup tables: intent→command, launch workflow, setup

---

### Rule 7 — Diagnose failures immediately; never ask the user to diagnose

**On any CLI error — wrong subcommand, unknown flag, invalid argument, type mismatch, timeout, unexpected output — the immediate and automatic response is: introspect (run `--help` or check COMMANDS.md), correct, retry. Never report a CLI error to the user before attempting self-correction. Never ask for permission to retry.**

On any failure (command error, timeout, unexpected output, wrong result):

1. **Immediately introspect** — run CLI tools to determine the cause before reporting to the user. Do not ask the user what happened.
2. **Report succinctly** — what was tried, what the error was, what the introspection revealed. No speculation, no options list.
3. **Correct and retry if possible** — if the cause is a wrong topic name, wrong type, missing publisher, or inactive controller, fix it and retry without asking.
4. **Escalate only when genuinely stuck** — if introspection cannot resolve the issue (hardware fault, missing node stack, environment problem), report exactly what was found and suggest one specific next step.

**Never:**
- Ask the user to interpret an error message that can be checked with the CLI
- Present a menu of options ("would you like to check odometry / retry / troubleshoot?") — pick the right action and do it
- Silently ignore an error or continue as if it did not happen
- Speculate about the cause without first running the diagnostic commands
- Ask the user for permission to retry after a self-inflicted error (wrong subcommand, wrong flag) — self-correct and retry immediately

**Pre-escalation diagnostic — elevate log level before asking the user:**
If the cause of a failure is not apparent from standard introspection (wrong output, unexpected behaviour, silent failure, inconsistent results), elevate the log level for the relevant node before escalating to the user. This often reveals the root cause without user intervention:
```bash
# Step 1: find the SetLoggerLevel service for the relevant node
services find rcl_interfaces/srv/SetLoggerLevel

# Step 2: set log level to DEBUG (level 10 = DEBUG, 20 = INFO, 30 = WARN, 40 = ERROR)
services call <SET_LOGGER_LEVEL_SERVICE> '{"logger_name": "", "level": 10}'

# Step 3: retry the failing operation and observe the additional output

# Step 4: reset to INFO when done
services call <SET_LOGGER_LEVEL_SERVICE> '{"logger_name": "", "level": 20}'
```
Use `logger_name: ""` to affect the root logger, or specify the node's fully qualified logger name (e.g., `"my_controller"`) to narrow the scope. **Only escalate to the user if debug-level output still does not identify the cause.**

**Stalled node — executor starvation check:**
If a node appears in `nodes list` and its input topics are actively publishing (`topics hz <input_topic>` > 0) but the node produces no output, check for a known starvation pattern: `SingleThreadedExecutor` combined with a `ReentrantCallbackGroup`. A long-running callback (timer, service handler, or subscriber) occupies the single executor thread and blocks all other callbacks from firing — including downstream publishers, other timers, and response handlers. The ROS 2 CLI cannot expose executor type directly. Diagnose in order:
1. Use the pre-escalation log-level elevation above — look for a callback that enters (log line at function entry) but never returns (no corresponding exit or completion log line at DEBUG level).
2. If the node's source code is accessible, check the executor type in `main()` or in the launch configuration.
3. **Recommended fix:** replace `SingleThreadedExecutor` with `MultiThreadedExecutor`, or restructure the blocking callback into a non-blocking pattern. Report this as the root cause if confirmed — do not retry the same command expecting a different result.

**Robot not moving — silent controller rejection diagnostic:**
If odom velocity stays ≈ 0 for more than 2 s after a `publish-until` or `topics publish` command was issued (i.e., commands are being sent but the robot is not responding), apply this diagnostic in order — do not guess:

1. **Confirm commands are reaching the topic:** run `topics hz <VEL_TOPIC> --duration 2`. If rate = 0 Hz → the publishing command itself failed; retry with the correct topic. If rate > 0 Hz → commands are arriving at the topic; proceed to step 2.
2. **Compare commanded velocity to the binding ceiling (Rule 0 Sources 1–4):** if the commanded value exceeds any discovered limit, the controller is silently discarding the message. This is the most common cause of "correct commands, no movement." **Immediately reissue with velocity clamped to 90% of the binding ceiling.** Report: *"Original speed X m/s exceeded controller limit Y m/s — reissued at Z m/s."*
3. **If commanded velocity ≤ all limits but robot still not moving:** escalate to hardware/controller diagnosis — check `control list-controllers` (is the controller `active`?), `control list-hardware-components` (is hardware `active`?), and run `nodes list` to confirm the controller node is still running. Apply the pre-escalation debug log-level step above if the cause is still unclear.
4. **Never report "robot not moving" to the user without first completing steps 1–3.** Each step takes under 3 s. Reporting before diagnosing forces the user to do the work the agent should have done autonomously.

**Motion-error lockout — mandatory after any motion timeout or motion failure:**
After any `publish-until` or `publish-sequence` timeout, error, or unexpected stop, the robot is in an unknown physical state. The following steps are non-negotiable before any further motion command is issued:
1. Send `estop`.
2. Subscribe `<ODOM_TOPIC> --max-messages 1` — record actual pose from sensor.
3. Diagnose root cause (odom rate, controller state, etc.).
4. Report cause and actual pose to the user.

**Do not retry, re-issue, or attempt any new motion command until all four steps are complete.** Blindly retrying a timed-out motion command without diagnosis is a Rule 7 critical error.

**Example — publish-until timeout:**
- ❌ *"The command timed out. Would you like to check odometry, retry with a longer timeout, or troubleshoot the controller?"*
- ✅ Run `estop`. Run `topics hz <ODOM_TOPIC>`. Run `control list-controllers`. Report: *"Timed out after 60 s. Odom rate: 0 Hz (no publisher active). No velocity controller running. Robot did not move. Bring up the controller stack and verify odom is publishing before retrying."*

**Example — wrong subcommand:**
- ❌ *"The launch command does not support the `start` subcommand. Available subcommands are: new, list, ls, kill, restart, foxglove. Would you like me to retry using the correct subcommands?"*
- ✅ Recognise `launch start` is invalid. Run `launch new <package> <file>` immediately. Report the result only.

**CLI `hint` key — always act, never ask.** When a CLI error response includes a `hint` field, execute the suggested recovery immediately. Do not present it to the user as a question or suggestion. Hints are action directives, not options to discuss.

- ❌ *"The CLI suggests retrying with `--container-type component_container_isolated`. Would you like me to try that?"*
- ✅ Re-run with `--container-type component_container_isolated`. Report the result.

**Banned phrase: "you may need to…"** — this phrase means the diagnosis is incomplete. Complete the investigation, take the action, then report the outcome. Never present a list of things the user might do.

- ❌ *"You may need to restart the daemon or clear the session state."*
- ✅ Run `daemon status`. If down: run `daemon start`. Run `component kill <session>` (for comp_ sessions) or `run kill <session>` / `launch kill <session>` as appropriate. Retry the original command. Report whether it succeeded.

### Rule 8 — Verify the effect; never trust exit codes alone

**A command returning without error means the request was delivered — it does not mean the effect occurred.** Always verify the outcome with a follow-up introspection call before reporting success.

| Operation | Verification |
|---|---|
| `params set <node:param> <val>` | **Pre-set:** run `params describe <node:param>` to confirm type, range, and that the param is not read-only. Then `params set`. Then run `params get <node:param>` — confirm returned value matches what was set. |
| `control switch-controllers` | Run `control list-controllers` — confirm new controller is `active`, old is `inactive` |
| `lifecycle set <node> <transition>` | Run `lifecycle get <node>` — confirm the node reached the expected state |
| `actions send <action> <json>` | **Pass a timeout flag** (check COMMANDS.md or `actions send --help` for the flag name). On return: check `status` — `SUCCEEDED` = completed; `FAILED` or `CANCELED` = treat as failure, diagnose per Rule 7. **If the command hangs past the timeout:** immediately send `actions cancel <goal_id>` (use the goal ID returned at submission), then diagnose why the action server did not respond. Never leave an action goal orphaned. Monitor feedback messages during execution: if a navigation action sends feedback with no progress for > 10 s, treat as stuck, cancel, and diagnose. |
| `control load-controller` / `control switch-controllers` / `control configure-controller` | 1. Run `control list-controllers` — confirm controller reached the expected state (`active` or `inactive`). 2. Run `control list-hardware-components` — confirm the hardware component is still `active`. If the hardware component is `inactive` after a controller operation, no velocity commands will be executed — this is the most common silent failure in ros2_control. |
| `services call` response | After any service call, inspect the response JSON. If it contains a `success`, `status`, `result`, or `error` field whose value indicates failure (e.g., `"success": false`, `"status": "ERROR"`, non-empty `"error"` string), treat as a failure and diagnose per Rule 7. A zero-error CLI return code only means the request was delivered — it does not mean the operation succeeded. |
| `topics publish` (single shot, state-change intent) | Run `topics subscribe <topic> --max-messages 1 --timeout 3` or `topics hz <topic>` to confirm messages are being received |
| `estop` (emergency stop) | After sending `estop`, verify it took effect: subscribe `<ODOM_TOPIC> --max-messages 1 --timeout 5` and check `twist.twist.linear.x`, `.y`, and `twist.twist.angular.z` are all < 0.01. If velocity is still non-zero after 5 s: the estop was not received (controller may be down or topic is wrong). **Critical failure — do not proceed with any command.** Report immediately: *"Estop sent but velocity still non-zero — robot may not have stopped. Controller or velocity topic may be offline."* **Heavy platforms (> 20 kg or platforms with significant mechanical inertia):** allow 10 s before declaring critical failure — braking distance is longer and the deceleration phase will exceed the standard window. |
| Movement completion (position / orientation reporting) | **Three-phase protocol — all steps required:** (1) Confirm odom is still live: run `topics hz <ODOM_TOPIC> --duration 1` — if rate < 5 Hz, flag as degraded before reporting. (2) Confirm the robot is stationary: subscribe `<ODOM_TOPIC> --max-messages 1`; check `twist.twist.linear.x`, `twist.twist.linear.y`, and `twist.twist.angular.z` are all < 0.01 m/s or rad/s. If any exceed 0.01, wait 0.5 s and repeat. (3) Once confirmed stationary, subscribe `<ODOM_TOPIC> --max-messages 1` and report position, orientation, or yaw from **this** reading only. **Covariance check:** if `pose.covariance[0]` (x-variance) > 0.1 m² or `pose.covariance[35]` (yaw-variance) > 0.1 rad², qualify the report: *"Pose reported but covariance is high — estimate may be unreliable."* |
| Motion timeout (`publish-until` or `publish-sequence` did not complete) | 1. **Immediately send `estop`** — verify it took effect (see estop row above). 2. Subscribe `<ODOM_TOPIC> --max-messages 1` — record actual final pose (sensor truth, not estimated). 3. Diagnose: run `topics hz <ODOM_TOPIC>` and `control list-controllers`. 4. Report: actual final position/orientation, distance covered vs. target, diagnosed cause. 5. **Do not send any further motion commands until root cause is identified and reported.** |
| Motion error (command error, type mismatch, unexpected stop, any failure) | 1. Send `estop` and verify it took effect. 2. Subscribe `<ODOM_TOPIC> --max-messages 1` — record actual pose at time of failure. 3. Diagnose per Rule 7. 4. Report: actual pose from sensor, error description, root cause. **Do not proceed with any motion until root cause is resolved.** |

**Reading odometry while the robot is moving produces wrong results.** The robot may still be decelerating or coasting when a motion command returns. The only correct time to read odometry for position or orientation reporting is after the robot is confirmed physically stationary — `twist.twist.linear.x`, `.y`, and `twist.twist.angular.z` are all ≈ 0. Post-motion odometry is a two-step operation: first confirm stationary, then subscribe and report.

Never report yaw, position, or distance from any reading taken while motion was ongoing — including the final message delivered just before the command returned.

**Never use the words "Done", "Succeeded", "Completed", "Applied", or any equivalent without first running the verification step for that operation type.** A zero-error CLI response is not verification — it is only evidence that the request was delivered.

If verification reveals the effect did not occur (param unchanged, controller not switched, lifecycle state unchanged): diagnose immediately per Rule 7, correct, retry, and verify again. Do not move on until the verification passes.

**Verification retry protocol:** All verification steps include one automatic retry to account for transient ROS 2 communication delays (DDS discovery lag, executor spin delay). If verification still fails after the auto-retry: apply a correction (diagnose per Rule 7, fix the root cause) and re-verify up to 2 additional times. After 3 total verification attempts with no success, escalate as a critical failure — do not loop indefinitely.

**Exception:** For `publish-until` and `publish-sequence`, the command's own stop condition or duration is the execution criterion — do not add a separate `topics hz` check **during** an active motion sequence. This exception applies only to checking delivery-rate mid-motion. It does **not** exempt the post-motion two-phase odometry read required for position/orientation reporting — that step is always mandatory after motion completes.

### Rule 16 — Multi-step tasks: complete and verify each step before starting the next

When a user's request involves a sequence of sub-commands (e.g., "move forward 1 m, then rotate 90°", "switch to controller A, then send a trajectory"), treat each sub-command as an independent atomic step:

1. **Execute step N.**
2. **Verify step N completed successfully (Rule 8)** — confirm the effect occurred, not just that the command returned without error.
3. **Only then start step N+1.**
4. **If step N fails:** stop the sequence immediately. Diagnose per Rule 7. Do not proceed to step N+1 with a failed or partial state from step N.

**Never pipeline or parallelise dependent steps.** Starting step N+1 before step N is confirmed complete risks compounding errors: the second command acts on a state the first command never achieved.

**Independent steps within the same phase** (e.g., discovering the velocity topic and discovering the odom topic) can and should run in parallel (Rule 12). The sequencing requirement applies only to steps where step N+1 depends on step N's outcome.

**Examples:**

| Request | Correct sequencing |
|---|---|
| "Move 1 m forward, then rotate 90° right" | 1. Discover topics → 2. publish-until forward → **verify odom delta** → 3. publish-until rotate → verify rotation |
| "Configure the arm controller, then send a trajectory" | 1. `control configure-controller` → **verify `inactive`** → 2. `control switch-controllers --activate` → **verify `active`** → 3. `actions send` |
| "Set max speed to 0.3, then move forward" | 1. `params set` → **`params get` to verify** → 2. discover topics → 3. publish-until |

**If any step in the sequence changes the robot's physical state** (position, controller state, parameter value), verify that change before building on it.

**Motion sequence pose carry-forward:** when step N is a motion command, the post-motion verified end-pose (from Rule 8 movement completion protocol) is automatically the pre-motion baseline for step N+1 — **do not issue a redundant Rule 9 odom subscribe** between consecutive motion steps in the same sequence. The verified end-pose already represents a fresh, stationary, sensor-confirmed reading. Re-run the Rule 9 node-presence check (parallel `nodes list`) before step N+1, but skip the odom subscribe — use the carry-forward pose as the new baseline instead.

---

## Error Recovery Protocols

### tmux Session Errors

Any error related to a tmux session or component container follows this recovery protocol — investigate and act autonomously, never present options for the user to choose.

| Error condition | Autonomous recovery |
|---|---|
| "Session already exists" on any command (`launch new`, `run new`, `component standalone`) | 1. Get session name from the `session` field of the JSON error. 2. Run `component kill <session>` (comp_ sessions), `run kill <session>` (run_ sessions), or `launch kill <session>` (launch_ sessions). 3. Immediately retry the original command. Report the final outcome only. |
| `container_found_at` in `component standalone` error | Retry immediately with `--container-type component_container_isolated`. Report the result. Do not ask. |
| `container_started: true` in `component standalone` error | Container process is alive but slow to initialize. Retry with `--timeout 30`. Report the result. |
| `container_started: false` in `component standalone` error | Container crashed. Check `run list` for what is alive. Report actual state, not speculation. |
| Stale session not cleared by `run kill` | Run `tmux kill-session -t <session>` directly. Verify with `tmux list-sessions`. Then retry the original command. |
| `session_killed` in any CLI response | The CLI already cleaned up the session. Just retry the original command with any corrected arguments. |

**Protocol:** (1) investigate with tools, (2) take corrective action, (3) report the final outcome. Never report intermediate steps or ask for approval at any stage.

### Subscribe Timeouts

| Error | Recovery |
|-------|----------|
| `Timeout waiting for message` | 1. Check `topics details <topic>` to verify publisher exists<br>2. Try a different topic if multiple exist<br>3. Increase `--duration` or `--timeout` |

### Publish Failures

| Error | Recovery |
|-------|----------|
| `Could not load message type` | 1. Verify type: `topics type <topic>`<br>2. Ensure ROS workspace is built |

### Service/Action Failures

| Error | Recovery |
|-------|----------|
| Service not found | 1. Verify service exists: `services list`<br>2. Check service type: `services type <service>` |
| Action goal rejected | 1. Check action details for goal requirements<br>2. Verify robot is in correct state |
