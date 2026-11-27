# Project boards

View GitHub Projects (v2) boards inside T3 Code, move items between columns, and start agents on issues directly from cards.

## Open a board

1. Click **Board** in the sidebar, or run **Open board** from the command palette (`Cmd/Ctrl+K`). Both open `/board`.
2. Select a project whose repository is on GitHub.

On your first visit to a project with no boards, T3 Code displays a list to add one.

T3 Code uses the host's GitHub sign-in (`gh`) to read and update boards. The token requires the `project` scope. If boards do not load, run:

```sh
gh auth refresh -s project
```

## Manage project boards

A T3 project can hold several boards. In the page header, a board switcher breadcrumb (after the project name) lists all boards added to the project.

Open the switcher menu to manage boards:

- **Add a board…**: Opens a dialog listing the repository's GitHub boards that have not been added yet.
- **Remove “<title>” from this project**: Asks for confirmation before removing the board. The board remains on GitHub and can be added again later.

Adding or removing a board requires the server's settings permission and applies to everyone connected to the server.

Each person chooses which board they view. Your choice is kept in the URL (`?board=`) and remembered per project on that device. If someone removes the board you are currently viewing, you are moved to the project's first board.

## Move items

Drag a card between columns, or open the card's menu and choose **Move to**.

You can also use the keyboard: focus a card, press Space, move with the arrow keys, and press Space again. Moves go to GitHub at once and reach every viewer live.

## Start an agent on an issue

Click **Start agent** on an open issue card. Choose **New worktree** (default) or **Project checkout**, and optionally enter extra instructions.

T3 Code then:

- starts a thread with the issue and its latest comments as the prompt,
- links the thread to the issue,
- moves the card to **In Progress** if that column exists.

The card displays live agent status. The agent is told to put `Closes owner/repo#N` in its pull request so GitHub links the pull request to the card.

If an agent is already working on that issue, T3 Code asks before starting another. Drafts and pull requests cannot start an agent. If the project has no usable default model, T3 Code uses the first signed-in provider's default model.

## Live updates

While anyone has the board open, the server checks GitHub every 20 seconds.

For updates in about a second, open the board settings menu and choose **Set up webhooks…**. This installs signed repository webhooks (requires a public URL, such as a tunnel) that post to `POST /api/github/webhooks` with HMAC SHA-256 verification.

Board-only field changes on user-owned boards still arrive via the 20-second check, as GitHub does not send webhooks for them.

## Agent tools

Agents can use three MCP tools to interact with boards:

- `list_project_boards`
- `move_board_item`
- `start_board_agent`

## Mobile

On mobile, the **Issues** tab includes a **Board** menu that opens a project's board.

From mobile, you can switch boards, move items, and start agents. Adding and removing boards must be done on the web or desktop app.
