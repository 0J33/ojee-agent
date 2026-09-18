# ojee-agent

The **AI and automation** module: n8n's workflows, the Odysseus stack, and the services those two
run on.

Runs standalone or as an [ojee-console](https://github.com/0J33/ojee-console) module.

---

## What changed, and why

This used to be a host dashboard — CPU graphs, memory bars, every container on the box, and a
whitelist of restart commands for things it had nothing to do with. All of that is gone.

Monitoring lives in [ojee-fleet](https://github.com/0J33/ojee-fleet), which reads the machine
directly rather than asking a service *on* that machine, over HTTP, for numbers already sitting in
`/proc`. A module that both watched the host **and** ran the automations was two modules wearing
one name, and neither half could be understood without ignoring the other.

What is left is one thing: the automation stack.

---

## What it shows

**Overview** — whether the stack is up, how many workflows are active, what ran recently and what
failed.

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
| `CODE_AGENT_URL` / `CODE_AGENT_TOKEN` | optional code-agent reachability probe |
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
| `GET /api/code` | whether the code agent is reachable |

---

## Licence

MIT.
