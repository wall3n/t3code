import type { ProjectBoard } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { boardRows } from "./handlers.ts";

it("names items and columns the way an agent passes them back", () => {
  const board = {
    summary: { id: "PVT_1", number: 4, title: "Roadmap", url: "u", owner: "acme", closed: false },
    host: "github.com",
    statusFieldId: "F",
    columns: [
      { id: null, name: "No Status", color: null, description: "" },
      { id: "todo", name: "Todo", color: "GRAY", description: "" },
    ],
    items: [
      {
        id: "I_1",
        kind: "issue",
        title: "Fix login",
        url: "https://github.com/acme/app/issues/12",
        repository: "acme/app",
        number: 12,
        state: "open",
        columnId: "todo",
        assignees: [],
        labels: [],
        linkedPullRequests: [],
        threadIds: ["t1", "t2"],
        updatedAt: "2026-11-27T00:00:00Z",
      },
      {
        id: "I_2",
        kind: "draft",
        title: "Idea",
        url: null,
        repository: null,
        number: null,
        state: null,
        columnId: null,
        assignees: [],
        labels: [],
        linkedPullRequests: [],
        threadIds: [],
        updatedAt: "2026-11-27T00:00:00Z",
      },
    ],
    truncated: false,
  } as unknown as ProjectBoard;
  expect(boardRows(board)).toEqual({
    boardId: "PVT_1",
    columns: ["No Status", "Todo"],
    items: [
      {
        itemId: "I_1",
        kind: "issue",
        title: "acme/app#12 Fix login",
        column: "Todo",
        url: "https://github.com/acme/app/issues/12",
        agentThreads: 2,
      },
      { itemId: "I_2", kind: "draft", title: "Idea", column: null, url: null, agentThreads: 0 },
    ],
    truncated: false,
  });
});
