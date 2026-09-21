# ojee-agent

The **AI and automation** module: unattended Claude Code sessions on the host, n8n's workflows,
the Odysseus stack, and the services those run on.

Runs standalone or as an [ojee-console](https://github.com/0J33/ojee-console) module.

---

## What changed, and why

This used to be a host dashboard — CPU graphs, memory bars, every container on the box, and a
whitelist of restart commands for things it had nothing to do with. All of that is gone.

Monitoring lives in [ojee-fleet](https://github.com/0J33/ojee-fleet), which reads the machine
directly rather than asking a service *on* that machine, over HTTP, for numbers already sitting in
`/proc`. A module that both watched the host **and** ran the automations was two modules wearing
one name, and neither half could be understood without ignoring the other.

What is left is one thing: the AI and automation stack — and since 2.1, the Claude Code sessions
that run on the same box.

---

## What it shows

**Overview** — whether the stack is up, how many workflows are active, what ran recently and what
failed.

**Claude** — Claude Code sessions running unattended on the host, in any folder. Each opens to its
real terminal (tmux, attached in the browser), a readable transcript, and a message box. See
[Claude sessions](#claude-sessions) below.

**Workflows** — every n8n workflow, whether it is active, when it last ran and how that went, with
activate/deactivate. Recent executions underneath.

**Odysseus** — its health, its version, and the four containers it runs on.

**Services** — the containers *this module is responsible for*: n8n, Odysseus, ChromaDB, SearXNG,
ntfy, CouchDB. Deliberately a list rather than "every container on the host" — fleet shows all of
them, and a second slightly-different answer to the same question is the kind of overlap where the
two eventually disagree and you have to work out which one is lying.

---

## Failure modes, as states

The failure that actually happens here is an n8n API key that n8n no longer accepts. It answers
401 to everything, and **"no workflows" and "you are not allowed to ask" must not look the same on
screen**. So the module distinguishes:

| | |
|---|---|
| `no-key` | No API key is configured — set `N8N_API_KEY` |
| `bad-key` | n8n rejected it — issue a new one under Settings → API |
| `unreachable` | n8n is not answering at all |

Each comes back as a sentence that says what to do, not "failed to load".

Similarly, a container that is **absent** and one that is **stopped** are different states: one is
a deployment that never included that piece, the other is a piece that died.

And a redirect from Odysseus is a service that is up and guarding itself, not one that is down.

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
| `GET /module.json` | the console's manifest |
| `GET /api/health` | is this service alive, and is its stack running |
| `GET /api/summary` | status, headline, facts, alerts — the console's front page |
| `GET /api/services` | this module's containers, with present/running distinguished |
| `POST /api/services/:id/restart` | restart one of them |
| `GET /api/n8n/workflows` | workflows, or a sentence explaining the refusal |
| `GET /api/n8n/executions` | the last 25 runs |
| `POST /api/n8n/workflows/:id/(activate\|deactivate)` | toggle one |
| `GET /api/odysseus` | health and version |
| `/api/claude/*` | proxied to the Claude runner, token added here (HTTP, SSE and the terminal WebSocket) |

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

To `CLAUDE_DISCORD_WEBHOOK` — its own webhook, not fleet's. On by default: needs your input,
blocked, errors, gone quiet, model switched, account switched, all accounts out, needs login. Off by
default: finished. Each can be switched in Settings; each links to the session.

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

`npm test` in `claude-runner/` runs the unit tests; the end-to-end suite
(`tests/integration.test.js`) drives real tmux and a fake `claude` that writes real-shaped
transcripts, through a Fable limit, an account switch and a pause.

---

## Licence

MIT.
