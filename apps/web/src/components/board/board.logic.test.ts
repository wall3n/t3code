import type { ProjectBoard, ProjectBoardItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPendingMoves,
  boardColumns,
  columnIdFromDropId,
  columnDropId,
  matchesBoardQuery,
  settlePendingMoves,
} from "./board.logic";

const item = (id: string, columnId: string | null, extra: Partial<ProjectBoardItem> = {}) =>
  ({
    id,
    kind: "issue",
    title: `Item ${id}`,
    url: `https://github.com/acme/app/issues/${id}`,
    repository: "acme/app",
    number: Number(id),
    state: "open",
    columnId,
    assignees: [],
    labels: [],
    linkedPullRequests: [],
    threadIds: [],
    updatedAt: "2026-11-27T00:00:00Z",
    ...extra,
  }) as ProjectBoardItem;

const board = (items: ReadonlyArray<ProjectBoardItem>): ProjectBoard =>
  ({
    summary: { id: "P", number: 1, title: "Roadmap", url: "u", owner: "acme", closed: false },
    host: "github.com",
    statusFieldId: "F",
    columns: [
      { id: null, name: "No Status", color: null, description: "" },
      { id: "todo", name: "Todo", color: "GRAY", description: "" },
      { id: "done", name: "Done", color: "GREEN", description: "" },
    ],
    items,
    truncated: false,
  }) as ProjectBoard;

describe("board logic", () => {
  it("keeps a dropped card in its new column until a later revision answers", () => {
    const items = [item("1", "todo"), item("2", "todo")];
    const pending = new Map([["1", { columnId: "done", revision: 4 }]]);
    expect(applyPendingMoves(items, pending).map((i) => i.columnId)).toEqual(["done", "todo"]);
    expect(settlePendingMoves(pending, 4)).toBe(pending);
    expect(settlePendingMoves(pending, 5).size).toBe(0);
  });

  it("hides the no-status column while it is empty", () => {
    const view = boardColumns(board([]), [item("1", "todo")]);
    expect(view.map((c) => c.column.name)).toEqual(["Todo", "Done"]);
    const withLoose = boardColumns(board([]), [item("1", null)]);
    expect(withLoose.map((c) => [c.column.name, c.items.length])).toEqual([
      ["No Status", 1],
      ["Todo", 0],
      ["Done", 0],
    ]);
  });

  it("matches every word against title, number, labels and assignees", () => {
    const target = item("12", "todo", {
      title: "Fix login redirect",
      labels: [{ name: "bug", color: "d73a4a" }],
      assignees: [{ login: "octo", name: null, avatarUrl: null }],
    });
    expect(matchesBoardQuery(target, "login #12")).toBe(true);
    expect(matchesBoardQuery(target, "BUG octo")).toBe(true);
    expect(matchesBoardQuery(target, "logout")).toBe(false);
  });

  it("round-trips column drop ids, including no status", () => {
    expect(columnIdFromDropId(columnDropId(null))).toBeNull();
    expect(columnIdFromDropId(columnDropId("todo"))).toBe("todo");
    expect(columnIdFromDropId("card:1")).toBeUndefined();
  });
});
