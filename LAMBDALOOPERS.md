# LambdaLoopers guide

This guide covers the GitHub Projects fork (`github.com/wall3n/t3code`, branch `feat/github-project-boards`).

## What this fork adds

- Support for multiple GitHub Projects (v2) boards per project.
- Board switcher breadcrumb to add, switch, and remove boards.
- Live card moves synced directly with GitHub.
- Starting agents on issue cards in worktrees or checkouts.
- Live agent status indicators on cards.
- Polling and signed webhook updates for instant synchronization.
- MCP tools for agents: `list_project_boards`, `move_board_item`, and `start_board_agent`.
- Mobile board support in the Issues tab.

Read [project-boards.md](docs/user/project-boards.md) for full feature documentation.

## Requirements

Ensure your machine meets these requirements before starting:

- Node.js 26.13.1 (matches `engines.node` in `package.json`).
- Vite+ CLI (`vp`). See [the development guide](docs/operations/00_development.md) to install it.
- pnpm managed via `vp`.
- GitHub CLI (`gh`) signed in with the `project` scope:
  ```sh
  gh auth refresh -s project
  ```

## Run it locally

Never point a dev server at `~/.t3/userdata`. Use `--home-dir <folder>` instead.

1. Install dependencies:
   ```sh
   vp i
   ```
2. Start the development server with an isolated data directory:
   ```sh
   vp run dev --home-dir ~/t3-dev-data
   ```
3. Open the printed pairing URL in your browser.

## First steps

1. Add a project whose git repository is hosted on GitHub.
2. Click **Board** in the sidebar or run **Open board** (`Cmd/Ctrl+K`).
3. Add a board from the list.
4. Hover an open issue card and click **Start agent**.

## Sharing one server with the team

T3 supports multi-device collaboration. Other team members can connect to your running server instance.

1. Share your server pairing link or configure network access.
2. Connect from desktop, browser, or mobile devices.

Board updates and card moves sync to all connected viewers in real time. Read [remote-access.md](docs/user/remote-access.md) for connection and access details.

## Webhooks with a tunnel

Webhooks deliver issue and pull request updates in about one second.

1. Expose your local port with a public tunnel such as Tailscale or Cloudflare.
2. Open the board settings menu in T3 Code.
3. Select **Set up webhooks…**.
4. Enter your public tunnel URL.

T3 Code registers HMAC SHA-256 verified webhooks at `POST /api/github/webhooks`.

In dev mode, Vite refuses a request whose Host header is a tunnel name, and GitHub gets a 403. Make the tunnel rewrite the Host header:

```sh
cloudflared tunnel --url http://localhost:5733 --http-host-header localhost:5733
```

A server started with `t3` (not `vp run dev`) has no Vite layer, so it needs no rewrite.

## Keeping the fork in sync with upstream

Track changes from upstream `pingdotgg/t3code`.

1. Add upstream remote:
   ```sh
   git remote add upstream https://github.com/pingdotgg/t3code.git
   ```
2. Fetch upstream changes:
   ```sh
   git fetch upstream
   ```
3. Merge upstream default branch:
   ```sh
   git merge upstream/main
   ```

Note: This fork adds database migration 120 "ProjectBoards". If upstream adds its own migration 120, renumber our migration before merging.

## Checks before pushing

Run validation checks before pushing your branch:

1. Run changed file checks:
   ```sh
   vp run check:changed
   ```
2. Fix any reported lint, type, or formatting issues.

To run single test files, use the repository copy of Vite+: `./node_modules/.bin/vp test run <files>`. A global `vp` can load a second Vitest copy, and the tests then fail to start.
