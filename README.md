# ojee-agent

Host stats, container control, and a full Claude Code agent surface — in the browser, over a
tailnet. Runs standalone or as an [ojee-console](https://github.com/0J33/ojee-console) module.

Extracted from the `agent.ojee.net` stack (now [ojee-home](https://github.com/0J33/ojee-home))
when that repo was split so the home hub and the agent dashboard could be their own things.

---

## What it does

**Live host stats** — CPU (per-core load, temperature), GPU via `nvidia-smi`, RAM, swap, disk
usage and real I/O read from `/proc/diskstats`, network throughput, uptime. Sparklines over a
rolling 60-sample window.

**Services** — every running container, with restart controls.

**Actions** — a *whitelisted* command set (`ACTIONS` in `src/server.js`): restart individual
containers, `compose up`, `compose down`. Whitelisted rather than free-form on purpose; see
[Security](#security).

**Claude Code agent** — the substantial part. A directory picker to choose where a session runs,
concurrent sessions, streaming responses over SSE with tool calls rendered inline, a history
browser across every project with tool-collapsing, rename, delete, and resume-from-history. It
talks to a `code-agent` service on another machine over the tailnet; the dashboard proxies with a
server-side token so the browser never holds it.

---

## Standalone or mounted

```bash
npm install
npm start                     # http://localhost:8080
```

Standalone it serves its own shell from `public/`. Mounted, the console proxies `/agent/*` and
supplies the chrome; the same `ui/index.js` runs either way.

| Variable | Meaning |
|---|---|
| `PORT` | default 8080 |
| `CODE_AGENT_URL` / `CODE_AGENT_TOKEN` | the Claude Code service. Leave empty and the Code panel reports itself unavailable rather than erroring. |
| `N8N_DOMAIN`, `COUCHDB_DOMAIN`, `ODYSSEUS_DOMAIN` | quick links only |
| `LOQ_SFTP_URL` | an `sftp://` one-click for another machine |
| `TIMEZONE` | IANA name |

---

## Security

**This process mounts `docker.sock` and `/:/host:ro`.** That makes it effectively root for the
whitelisted actions: anyone who reaches it can restart your stack and read any file on the host.

It carries **no authentication of its own**, deliberately. Mounted, the console has already run
three gates — tailnet membership, TOTP, device trust — and asserts the caller in a signed
`X-Console-User` header. Standalone, the tailnet is the boundary. A password prompt in front of
that would add a thing to forget, not a layer of security.

The consequence is simple and worth stating plainly: **do not expose this outside a tailnet.**

---

## Notes from the extraction

- The UI is a **port**, not a rewrite. All 19 API routes and every code-agent feature survive.
  Removed only what the console now owns: the password login and its JWT, the header/HUD/tab
  chrome, and hash routing.
- Its stylesheet used to declare `--bg`, `--accent`, `--warn` and `--info` at `:root`. Those are
  ojee-ui token names, so at `:root` they silently overrode the design system for the whole page
  — including the shell's own chrome — and froze the module on one palette. They are now scoped
  to the module root and *derived* from ojee-ui tokens, so switching the console to the light
  theme carries this module with it.
- Radii are flattened to zero to match the system, with one exception: the loading skeleton for
  the circular gauge stays round, because a square placeholder for a round thing visibly jumps
  when the real gauge arrives.

---

## Licence

MIT.
