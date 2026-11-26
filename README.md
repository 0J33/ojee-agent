# ojee-agent — Claude

The console's **Claude** module: unattended Claude Code sessions on every machine that runs them
(HP, and LOQ when it is awake), each through that machine's runner (`claude-runner/`).

Runs standalone or as an [ojee-console](https://github.com/0J33/ojee-console) module (id `agent`,
shown as Claude; deep links stay `#/agent/claude/<session>`).

---

## What it shows

One page, terminal-first:

- **Sessions** grouped by what they need — needs you, working, idle, ended — with what each is
  doing right now (the tool running, the question asked), on every device.
- **A session**: its real terminal (tmux, attached over a WebSocket) with a key bar for phones, or
  the same conversation as a **chat**, pushed live. Either is one tap away.
- **Accounts** and their standing (ok, limited until, needs login), switching, logging in.
- **Settings** per device: models and fallback, sessions at once, stall time, unattended, guard,
  resume after reboot, CPU governor and heat, pings.

Off or out of sight since the 26 Nov redesign:

| | |
|---|---|
| Assistant, Workflows, Odysseus | off behind `AGENT_DISABLE` (src/features.js), code kept |
| the stack's containers (n8n, CouchDB…) | a health check that says nothing until one is down: then one line in the Claude page with Restart, and an `agent.service-down` alert |
| Work (Forsa) | moved to forsa-aios; the UI is gone (git history: `ui/work.js` before `redesign`); only the endpoints HP's loop still calls stay, server-side (`src/work-legacy.js`) |

### How the chat gets its data

| what | where it comes from |
|---|---|
| the conversation | the runner's **live channel**, `GET /sessions/:id/live` (SSE): the last 2 MB of the transcript on connect, then each new line as Claude Code writes it (fs.watch + a 1 s poll) |
| state, the tool running now, the queue | the session's hooks and transcript, pushed as `session` events on the same channel |
| questions, plans, permissions | the hooks themselves — `PreToolUse` (AskUserQuestion with its options, ExitPlanMode with the plan) and `PermissionRequest` (the tool and what it would do) — drawn as cards; answering is `POST /sessions/:id/answer`, keys worked out from the hook's data |
| your message | drawn the moment it is sent, then replaced by the real one when it reaches the transcript (or Claude Code's queue, which the transcript also records: `queue-operation` entries) |
| images, diffs, exit codes, hook output | the transcript: images by reference (`/sessions/:id/media/:id`), Edit/Write hunks from `structuredPatch`, `Exit code N`, `hook_*` attachments; outputs over 20 KB load whole on demand (`/sessions/:id/full/:toolUseId`) |

**What is still read off the screen** (and why there is no structured source): the permission
mode (⏵⏵ bypass…), Claude Code's suggested next message, words typed in the terminal box but not
sent, and the *options* of a dialog no hook spells out (a plan or permission dialog's choices,
`/model`, a notice menu). Read every 1.5 s only while someone watches a session, sent only on a
change. The runner also still reads the screen at boot (folder-trust and bypass prompts), to
decline notice menus between turns, and to keep your draft when a queued message is taken back.

stream-json / the Agent SDK were not used for interactive sessions: a session is the real
`claude` TUI in tmux, which the terminal tab attaches to, and stream-json mode has no TUI.

---

## Setup

```bash
npm install
npm start                     # http://localhost:8080
```

| Variable | Meaning |
|---|---|
| `N8N_URL` | default `http://n8n:5678` |
| `N8N_API_KEY` | n8n → Settings → API. Without it the workflow views say so. |
| `ODYSSEUS_URL` | where Odysseus answers; omit and the section is absent |
| `CLAUDE_RUNNER_URL` / `CLAUDE_RUNNER_TOKEN` | the host's Claude runner; without them the Claude view says so. `CODE_AGENT_URL` / `CODE_AGENT_TOKEN` are still read. |
| `N8N_DOMAIN` / `ODYSSEUS_DOMAIN` / `COUCHDB_DOMAIN` | display links only |

**Security:** this process talks to the Docker socket to restart its own stack's containers. The
container *name* always comes from `docker ps`, never from the request — a request only picks
which of this module's own services to act on. Do not expose it beyond a tailnet.

---

## API

| | |
|---|---|
| `GET /module.json` | the manifest: one view (Claude), every alert kind (`alerts`/`notifications`) |
| `GET /api/health` | alive, and whether the stack's containers run |
| `GET /api/summary` | status, headline, four metrics, a 2 h spark of sessions working, alerts with stable keys |
| `GET /api/stack` | the stack's containers, down ones only matter; `POST /api/services/:id/restart` |
| `GET /api/events` | `notify` events for the console (src/notify-stream.js) |
| `/api/claude/*` | proxied to the runners, token added here (HTTP, SSE, the live channel, the terminal WebSocket) |
| `/api/work/{sweep,messages,replies,replies/handled}` | legacy, server-side only (below) |

### Alerts

Every kind is declared in the manifest (`blocking`, `channel`, `params`), so it appears in the
console's Settings → Notifications. A summary alert's `key` is its subject
(`<device>:<session or account>`) with `notify: <kind>`; runner pings arrive as `event: notify`
with the same key and `state: raise | resolve | update`, so an event and an alert are one item.

| kind | |
|---|---|
| `agent.claude-needs-input` | blocking (toast + push): a question, a plan, a permission |
| `agent.claude-blocked`, `-error` | inbox |
| `agent.claude-stalled` | quiet for `stallMinutes` (default 30) with no tool call open and nothing in the background |
| `agent.claude-needs-login` | an account logged out, found by a session **or by the 15-minute check** (once a day per account) |
| `agent.claude-account-limited`, `-all-limited` | limited until a reset; every account out |
| `agent.claude-model-fallback`, `-account-switch`, `-done` | digest / off by default |
| `agent.claude-runner-down`, `agent.service-down` | a runner or a container down |

### Kept for the Forsa loop until forsa-aios replaces it

| endpoint | caller on HP |
|---|---|
| `POST /api/work/sweep?ifDue=55` | n8n "Forsa work loop", every ten minutes (types the sweep prompt into the Conductor session) |
| `GET /api/work/sweep` | when the last sweep went out |
| `POST /api/work/messages` | `~/.local/share/forsa-work/notify.py` (Claude's messages to the owner → notifications) |
| `GET /api/work/replies`, `POST /api/work/replies/handled` | `owner_replies.py` |
| runner `GET/POST /api/work/tick` | the old Refresh; kept in the runner |

---

## Claude sessions

The Claude view is two pieces, both in this repo:

| | where it runs | why there |
|---|---|---|
| `ui/claude*.js` + the `/api/claude/*` proxy in `src/server.js` | this module's container | it is part of the console |
| `claude-runner/` | the **host**, as two `systemd --user` services | a session must start in any folder on the machine and use the user's own `~/.claude` — neither of which a container can do |

### What a session is

An ordinary interactive `claude`, with `--dangerously-skip-permissions`, inside a tmux session on a
private socket (`tmux -L ojee-claude ls`). The browser's terminal is `tmux attach` over a
WebSocket, so it is the real one: attach from a phone and a laptop at once, close the tab and it
keeps running, restart the runner and it keeps running (the tmux server is its own unit).
Sessions run Claude Code's fullscreen renderer (`"tui": "fullscreen"`), so clicks and the wheel
reach Claude.

The browser terminal behaves like a desktop app about the clipboard — your computer's, not the
box's. Selecting text in Claude copies it (Claude sends OSC 52; tmux passes it on; xterm's clipboard
add-on writes it). Shift+drag (Option+drag on a Mac) selects in the browser and copies too.
Ctrl+C copies a browser selection and is otherwise Claude's; Ctrl+Shift+C always copies;
Ctrl+V / Ctrl+Shift+V / Cmd+V paste — an image is uploaded to the box and its path pasted, which
Claude attaches as `[Image #n]`. Shift+Enter is a new line. The console's `/` and Ctrl+K
shortcuts never fire from inside the terminal, and typing anywhere on a session's page goes to it.
`/rename` in the terminal renames the session in the console too.

The runner knows what a session is doing from three sources, not from scraping the screen:

- **hooks** it adds with `--settings` — `SessionStart`, `UserPromptSubmit`, `Stop` (with the last
  reply), `Notification`, and `AskUserQuestion` — over a Unix socket;
- **the transcript** Claude Code writes (`~/.claude/projects/…/<id>.jsonl`) — which model answered,
  and every failed request with a machine-readable reason;
- **tmux** — whether the process is alive, and, while it boots, the screen (to answer a folder-trust
  prompt nobody is there to answer; normally pre-empted by marking the folder trusted in
  `.claude.json`).

Unattended sessions get an appended system prompt: decide rather than ask, end with `DONE:` or
`BLOCKED:`. The states follow from that — *working*, *idle*, *needs you*, *blocked*, *done*,
*paused*, *error*, *stopped*, *queued* (more than *Working at once*).

### Running out

Read from real transcripts (Claude Code 2.1.233–2.1.278), not guessed:

| message | what it means | what happens |
|---|---|---|
| "You've reached your **Fable** limit" (`apiError: model_requires_usage_credits`) | that model, on that account | continue on the **fallback model**, same account; the default is tried again after *Try the default again after* hours |
| "You've hit your **session** / **weekly** limit" (`quotaLimits`, with `resetsAt`) | the whole account | **auto-switch**: continue on the next account that is available; otherwise pause until the reset and resume on its own |
| "Not logged in" / "Login expired" | the account's login | the account is marked *needs login*, sessions move or pause, a ping says so |
| `API Error: 529 …`, connection lost | temporary | retried three times, two minutes apart |

"Continue" never uses `/model` — tested: that also saves the model as the user's default for every
new session. The runner restarts the process with `--resume <id>` and the new model or account,
and types why it was moved; the conversation carries on.

### Accounts

Normal subscription logins made with `claude auth login` — no API keys, no tokens. The first account
is the machine's own `~/.claude`. Each other one gets its own `CLAUDE_CONFIG_DIR` under
`~/.local/share/ojee-claude/accounts/<id>`, in which everything except the login is a symlink back
to `~/.claude` (history, settings, CLAUDE.md, plugins) — so any session can resume under any
account, and `claude --resume` typed by hand still finds it. Logging one in happens in the browser:
the Accounts view runs the login in a terminal and shows the sign-in link and a box for the code.

### Pings

To `CLAUDE_DISCORD_WEBHOOK` — its own webhook, not fleet's — sent by the runner itself, so a
session on the laptop still reaches you when HP is down. Which kinds are sent, to the app and/or
Discord, quiet hours and cooldowns are chosen in the console's Settings → Notifications (types
`agent.claude-*`); the console pushes those choices to this module (`POST /api/notify/prefs`),
which hands them to every runner (`PUT /api/notify-prefs`, kept in the runner's store, re-sent
when a runner comes back). Each ping is also a `notify` event on the runner's `/api/events`, which
this module relays onto its own `/api/events` for the console's app channel. Until a runner has
received the console's choices, its old per-kind switches apply. Defaults: needs your input,
blocked, errors, gone quiet, all accounts out, needs login → app + Discord; model/account switched
→ Discord; finished → off. Each links to the session. The Assistant's pings (`agent.assistant-*`)
are routed by the console the same way; `ASSISTANT_DISCORD_WEBHOOK` is only used when no console
is listening.

### Guard

A `PreToolUse` hook on Bash (hooks still run under bypass) blocks a short list: `sudo`, force-pushes,
touching `~/stack` from a session outside it, stopping or removing the console stack's containers,
stopping the runner, `rm -rf` of `/` or home. Not a sandbox; the list of mistakes that would take the
rest of the box down. Switchable in Settings.

### Install (on the host)

```bash
cd claude-runner
./deploy/install.sh            # deps, tmux (unpacked without sudo if missing), env, units — starts nothing
vim ~/.config/ojee-claude/env  # CLAUDE_DISCORD_WEBHOOK, CONSOLE_URL
./deploy/install.sh --start    # retires the old code-agent, enables both units
```

Then give this module `CLAUDE_RUNNER_URL=http://<tailnet ip>:7777` and the token from the env file.
Updating is `git pull && systemctl --user restart ojee-claude` — sessions survive it.

### More than one machine

Each machine that runs sessions has its own runner, accounts and settings (HP, and LOQ — a
laptop). The module lists them all: `CLAUDE_RUNNER_URL/_TOKEN` is the first (id `hp`, label `HP`;
`CLAUDE_RUNNER_ID/_LABEL` to change), and each other one is `CLAUDE_RUNNER_<ID>_URL`, `_TOKEN`,
`_LABEL`, and `_SLEEPS=1` when being offline is normal (a laptop asleep: drawn as a state, never an
alert). Or all of it as JSON in `CLAUDE_RUNNERS=[{id,label,url,token,sleeps}]`.

The module proxies each under `/api/claude/d/<id>/…` (HTTP, SSE, terminal WebSocket), merges their
states (`/api/claude/all/state`) and event streams (`/api/claude/all/events`, each event
`{device, data}` plus `device` events when one drops or returns), and adds their summaries up.
`/api/claude/…` without a device is still the first runner. In the UI: a device picker on New
(last used, else HP; an offline one disabled with the reason), the folder picker browses that
machine, sessions carry a device tag and can be filtered, and Accounts / Settings switch device.

Installing on a second machine: `DEVICE_ID=loq DEVICE_LABEL=LOQ PORT=7778 ./deploy/install.sh`,
then `--start` (never `--retire-code-agent` unless the old code-agent should go). Per-machine env:
`THERMAL_BACKOFF=0` (no temperature back-off, for a CPU that idles hot), `DEFAULT_CPU_CAP_PCT`,
`MACHINE_NOTE` (a line about the machine in the unattended instructions).

`npm test` in `claude-runner/` runs the unit tests; the end-to-end suite
(`tests/integration.test.js`) drives real tmux and a fake `claude` that writes real-shaped
transcripts, through a Fable limit, an account switch and a pause.

---

## The Assistant

Agent → Assistant, and the quick chat behind the console overview's Assistant
button (or the `a` key there). The model is OpenCode — `opencode serve` on HP
(`ojee-opencode.service`, tailnet address only) — with the console's own tools
wired in through `src/mcp.js`: fleet temperatures, the AC, the stack's
services, a shell on loq or disinteg.

- **One stream.** The module holds one subscription to opencode's
  `/global/event` and fans it out on `/api/assistant/events`, so replies stream
  part by part (reasoning, text, tool calls with their state) into whichever
  window is open — and a turn keeps going with none open.
- **Fallback.** A message is sent with `prompt_async` and watched. When the
  model refuses (quota, rate limit, the free tier saying no, a provider that
  keeps retrying, a reply with nothing in it) the failed exchange is deleted
  and the same words go to the next model; the page is told who took over.
- **Approvals.** Shell, file edits, console actions and web can each be
  Allow / Ask / Off (Settings). Ask puts an Allow / Always / Deny card inline
  under the tool call. **Off** removes the tool, which OpenCode's free tier
  refuses outright, so while anything is off only OpenCode Go models are used.
- **Pings** (needs you, failed, replied) go out as `notify` events on
  `/api/events` — the console phone app turns those into notifications — and to
  Discord when `ASSISTANT_DISCORD_WEBHOOK` is set.

| env | |
|---|---|
| `OPENCODE_URL` | `opencode serve`, e.g. `http://100.117.98.52:4799` |
| `OPENCODE_PATH` | default folder for new conversations (`/home/ojee`) |
| `OPENCODE_PROVIDERS` / `OPENCODE_MODELS` | which providers to offer / pin the head of the order |
| `OPENCODE_RETRY_LIMIT` | provider retries before moving to the next model (2) |
| `ASSISTANT_DISCORD_WEBHOOK` | optional Discord pings |
| `DATA_DIR` | where `assistant.json` (settings) lives (`/app/data` in the image) |
| `HOST_ROOT` | the host's `/` mounted read-only, for the folder picker (`/host` when present) |

## Licence

MIT.
