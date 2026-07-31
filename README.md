<p align="center">
  <img src="docs/astercaeser-wordmark.png" alt="AsterCaeser" width="238">
</p>

<p align="center">
  A self-hosted AI workspace for chat, agents, research, documents, email, notes, calendar, and local model workflows.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="docs/setup.md">Setup Guide</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="ROADMAP.md">Roadmap</a>
</p>

<p align="center">
  <a href="https://repology.org/project/astercaeser-ai/versions"><img src="https://repology.org/badge/vertical-allrepos/astercaeser-ai.svg" alt="Packaging status"></a>
</p>

<p align="center">
  <img src="docs/astercaeser-browser.jpg" alt="AsterCaeser interface">
</p>

---

## Quick Start

> `dev` is the default branch and gets the newest changes first. Use [`main`](https://github.com/astercaeser-dev/astercaeser/tree/main) if you want the more curated branch.

```bash
git clone https://github.com/astercaeser-dev/astercaeser.git
cd astercaeser
cp .env.example .env
docker compose up -d --build
```

Open `http://localhost:7000` when the containers are healthy. The first admin password is printed in `docker compose logs astercaeser`.

Native installs, GPU notes, Windows/macOS instructions, HTTPS, and configuration live in the [setup guide](docs/setup.md).

## Built-in MCP servers

AsterCaeser auto-registers several built-in MCP servers: email, memory, RAG, image generation, and a Playwright-based **Browser** (`builtin_browser` — available to agents as `mcp__builtin_browser__browser_*` tools).

The browser uses a **persistent profile** (`browser_user_data_dir` setting; default `data/browser-profile`), so logins survive restarts and the agent can read pages behind auth walls (e.g. a local dashboard). To sign into a site once:

1. Tell the agent `manage_settings` `set browser_headless false` — a visible browser window appears (or the change is applied on next startup).
2. Ask the agent to open the site with the browser and log in.
3. Set `browser_headless` back to `true` — the login persists in the profile.

Browser tools are only available when the `@playwright/mcp` npm package is cached (run `npx -y @playwright/mcp@latest --version` once to pre-install it).

## Features

- **Chat + Agents** — local/API models, tools, MCP, files, shell, skills, and memory.
- **Cookbook** — hardware-aware model recommendations, downloads, and serving.
- **Deep Research** — multi-step web research with source reading and report generation.
- **Compare** — blind side-by-side model testing and synthesis.
- **Documents** — writing-first editor with AI edits, suggestions, Markdown, HTML, CSV, and syntax highlighting.
- **Email** — IMAP/SMTP inbox with triage, tags, summaries, reminders, and reply drafts.
- **Notes, Tasks + Calendar** — reminders, todos, scheduled agent tasks, and CalDAV sync.
- **Extras** — gallery/image editor, themes, uploads, web search, presets, sessions, and 2FA.

## Demo

A full hover-to-play tour lives on the landing page: [`docs/index.html`](docs/index.html).

## Contributing

Help is welcome. The best entry points are fresh-install testing, provider setup bugs, mobile/editor polish, docs, and small focused refactors. See [CONTRIBUTING.md](CONTRIBUTING.md) and [ROADMAP.md](ROADMAP.md).

## Security

AsterCaeser is a self-hosted workspace with powerful local tools. Keep auth enabled, keep private data out of Git, and do not expose raw model/service ports publicly. Deployment details are in the [setup guide](docs/setup.md#security-notes).

## Star History

<a href="https://www.star-history.com/?repos=astercaeser-dev%2Fastercaeser&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=astercaeser-dev/astercaeser&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=astercaeser-dev/astercaeser&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=astercaeser-dev/astercaeser&type=date&legend=top-left" />
 </picture>
</a>

## License

AGPL-3.0-or-later -- see [LICENSE](LICENSE) and [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md).
