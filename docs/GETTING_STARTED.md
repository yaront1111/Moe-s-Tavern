# Your first task with Moe

This guide takes a local Git project from installation to one reviewed task using the JetBrains board. Build Moe and its plugin from the same source checkout so the daemon, board, and agent scripts match.

## Download and install

Download the [source ZIP](https://github.com/yaront1111/Moe-s-Tavern/archive/refs/heads/main.zip) and extract it. Open a terminal in the extracted `Moe-s-Tavern-main` folder. If you already have Git, cloning the repository is another way to get the same sources.

The installer supports Windows with WinGet, macOS with Homebrew and Command Line Tools, and Linux with apt-get or dnf. macOS/Linux support x64 and ARM64. Have a JetBrains IDE available for the board. System dependency installation may request your operating system password or permission; the installer stops if your system cannot provide a required package.

The **Moe checkout** below is the folder containing Moe's `scripts/` and `packages/`. Your **target project** is the repository the agents will work on. They can be different folders.

## Install and open the board

From the extracted Moe folder, run:

**Windows — PowerShell:**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-all.ps1 -BuildPlugin
```

**macOS / Linux — Bash:**

```bash
bash scripts/install-mac.sh --global --skip-mcp --with-plugin
```

The installer installs missing Node.js/npm, Git, the selected agent CLI, and JDK 17, then builds the daemon, proxy, and plugin. macOS/Linux also provision Python3, curl, and tar; Linux installs tmux for team terminals. Existing supported tools are reused. Node 18 is upgraded because current build tools require newer Node.js.

Claude Code is installed by default. To choose another CLI, add `-AgentCommand codex` or `-AgentCommand gemini` on Windows; add `--agent codex` or `--agent gemini` on macOS/Linux. Use `none` to skip provider CLI installation.

`--skip-mcp` leaves project MCP setup to the agent launcher. Keep the Moe folder on disk. New terminals load the installed command paths; on macOS/Linux, refresh an already open terminal with:

```bash
. "$HOME/.local/share/moe/env.sh"
```

In your IDE, open **Settings / Preferences → Plugins → gear icon → Install Plugin from Disk**, select the ZIP in `moe-jetbrains/build/distributions/`, and restart. Open **your target project**, then its **Moe** tool window. The plugin creates `.moe/`, starts the daemon, and shows **Connected** with an empty board.

In a new terminal, open your target project and run your chosen CLI (`claude`, `codex`, or `gemini`) once to complete sign-in. Confirm it responds. You need access to that provider; the installer does not perform account sign-in. Check `git status`, `git config user.name`, and `git config user.email` in this project before launching agents. Moe's default launchers commit task changes and attempt to push them to the project's remote.

Run this in another terminal, replacing the path with your target project, to check the daemon:

```bash
moe-daemon status --project "/path/to/your/project"
moe-daemon doctor --project "/path/to/your/project"
```

On Windows, use a quoted Windows path such as `"C:\code\my-project"`. `status` should report the running daemon; `doctor` should finish without hard failures.

## Create one small task

1. Open the board's **Project Settings** and keep **Approval Mode: CONTROL**. This requires you to approve an implementation plan.
2. Click **+ Epic** and create `First task`.
3. Use the **+** in that epic's **Backlog** column to open **Create Task**, and select your epic.
4. Enter a title, description, and Definition of Done. For a small documentation task, use:

   **Title:** Document how to run this project

   **Description:** Inspect the existing project configuration and add `GETTING_STARTED.md` with the setup, run, and test commands that actually exist in this repository.

   **Definition of Done:** The guide contains verified commands, records any required prerequisites, and its relative links resolve. Existing files and behavior remain unchanged.

5. Create the task and drag it into **Planning**. Creation puts a task in Backlog; moving it to Planning makes it available to an architect.

## Launch an architect and approve the plan

Use **Agents → Architect → your installed CLI** in the board. A terminal opens and the architect claims the Planning task. Leave that terminal open.

If you prefer an external terminal, open it in the **Moe checkout** and run:

**Windows:**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\moe-agent.ps1 -Role architect -Project "C:\code\my-project"
```

**macOS / Linux:**

```bash
./scripts/moe-agent.sh --role architect --project "/path/to/my-project"
```

These commands default to Claude Code. To use Codex, add `-Command codex` or `--command codex`, respectively. The launcher sets up the project's MCP connection and starts the daemon when needed.

Wait for **Awaiting Approval** on the task card in the **Planning** column. Open the task, read its steps and affected files, then click **Approve** if the plan matches your request. If it needs changes, reject it with specific feedback. No implementation should start while the plan is waiting for your approval in CONTROL mode.

## Run the worker and QA

After approving the plan, choose **Agents → Worker → your CLI**, then **Agents → QA → your CLI**. For external terminals, run the architect command above in two more terminals, replacing `architect` with `worker` and `qa`. Keep these terminals open during the task.

The worker implements the steps and runs verification, then submits the task to **Review**. QA reviews the result and can return it to the worker for fixes. A successful review moves it to **Done**.

Open the task and check its completed steps, verification output, QA summary, and recorded commit. Review the actual changed files in your project's Git history. A commit or push failure in the agent terminal needs attention even if the board has advanced.

Once this works, **Agents → All Agents** launches the roles together for subsequent tasks.

## When a step does not work

### Commands not found or global install permission errors

If `moe-daemon` is missing, check `npm prefix -g` and ensure the npm global command directory is on PATH. On Windows this is the prefix itself; on macOS/Linux it is the prefix's `bin` directory. Open a new terminal after changing PATH.

On macOS/Linux the installer selects its own user prefix when the current global prefix is not writable. It preserves your npm configuration. To load its tool paths in an existing terminal:

```bash
. "$HOME/.local/share/moe/env.sh"
```

If you use a Node version manager, check that your shell has loaded its configuration. Rerun the installer if the terminal still cannot find the tools.

You can also run the daemon directly from the **Moe checkout**, without global registration:

```bash
node packages/moe-daemon/dist/index.js status --project "/path/to/your/project"
```

The agent launch scripts also use the built files directly. Replace `status` with `doctor` or `init` as needed. `init` initializes the target and **keeps the daemon running**; use a separate terminal for other commands or stop it with Ctrl+C.

### The board is disconnected

Run `moe-daemon doctor --project "/path/to/your/project"` and follow its specific failures. Check that Node is available to the IDE; restart the IDE after installing Node or changing PATH. Check that the ZIP came from this checkout's successful plugin build. See [Troubleshooting](TROUBLESHOOTING.md#plugin-issues) for connection diagnostics.

### The agent cannot start or asks to sign in

Run your selected CLI directly in your target project, complete its sign-in/setup, then relaunch it from Moe. The terminal must be able to find that CLI. If `./scripts/moe-agent.sh` or `.\scripts\moe-agent.ps1` is missing, you are probably in the target project: open a terminal in the Moe checkout instead.

### The installer cannot find a package manager

Windows needs WinGet; macOS needs [Homebrew](https://brew.sh) and its Command Line Tools prerequisites. Linux automatic provisioning uses apt-get or dnf. On other distributions, install the dependencies named in the error through your distribution's package manager, then retry. This error means installation has not completed.

### The agent is idle or the task is waiting

- **Backlog:** drag the task to Planning before starting the architect.
- **Awaiting Approval:** open the task and approve the plan in CONTROL mode.
- **Working:** ensure a Worker terminal is running and inspect its output.
- **Review:** ensure QA is running and inspect its output.
- **Blocked:** read the task's reason and resolve the reported prerequisite before continuing.

### The task changed files but a commit or push failed

Read the agent terminal's Git error and check your project's Git identity, branch, remote, and authentication. Inspect the task's recorded commit evidence before treating it as delivered. Do not delete the working files to clear a board status.
