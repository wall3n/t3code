import type { ProjectBoard, ProjectBoardColumn, ProjectBoardItem } from "@t3tools/contracts";

/** A move this client made that the server has not pushed back yet. */
export interface PendingMove {
  readonly columnId: string | null;
  /** The board revision the move was made on; a later revision carries GitHub's answer. */
  readonly revision: number;
}

/** The items with this client's unconfirmed moves applied, so a dropped card stays put. */
export function applyPendingMoves(
  items: ReadonlyArray<ProjectBoardItem>,
  pending: ReadonlyMap<string, PendingMove>,
): ReadonlyArray<ProjectBoardItem> {
  if (pending.size === 0) return items;
  return items.map((item) => {
    const move = pending.get(item.id);
    return move === undefined ? item : { ...item, columnId: move.columnId };
  });
}

/** Drops the moves the server has answered: any revision after the one a move was made on. */
export function settlePendingMoves(
  pending: ReadonlyMap<string, PendingMove>,
  revision: number,
): ReadonlyMap<string, PendingMove> {
  let next: Map<string, PendingMove> | null = null;
  for (const [id, move] of pending) {
    if (move.revision < revision) {
      next ??= new Map(pending);
      next.delete(id);
    }
  }
  return next ?? pending;
}

/** Case-insensitive match on title, `#number`, repository, label and assignee. */
export function matchesBoardQuery(item: ProjectBoardItem, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    item.title,
    item.number === null ? "" : `#${item.number}`,
    item.repository ?? "",
    ...item.labels.map((label) => label.name),
    ...item.assignees.map((assignee) => assignee.login),
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export interface BoardColumnView {
  readonly column: ProjectBoardColumn;
  readonly items: ReadonlyArray<ProjectBoardItem>;
}

/** Columns in the board's order. The no-status column shows only while it holds an item. */
export function boardColumns(
  board: ProjectBoard,
  items: ReadonlyArray<ProjectBoardItem>,
): ReadonlyArray<BoardColumnView> {
  const byColumn = new Map<string | null, ProjectBoardItem[]>();
  for (const item of items) {
    const list = byColumn.get(item.columnId) ?? [];
    list.push(item);
    byColumn.set(item.columnId, list);
  }
  return board.columns
    .map((column) => ({ column, items: byColumn.get(column.id) ?? [] }))
    .filter((view) => view.column.id !== null || view.items.length > 0);
}

/** A column's droppable id. The no-status column has none of its own on GitHub. */
export const columnDropId = (columnId: string | null) => `column:${columnId ?? ""}`;

export function columnIdFromDropId(dropId: string): string | null | undefined {
  if (!dropId.startsWith("column:")) return undefined;
  const id = dropId.slice("column:".length);
  return id === "" ? null : id;
}

const COLUMN_DOT: Record<string, string> = {
  GRAY: "bg-zinc-400 dark:bg-zinc-500",
  BLUE: "bg-blue-500 dark:bg-blue-400",
  GREEN: "bg-emerald-500 dark:bg-emerald-400",
  YELLOW: "bg-amber-400 dark:bg-amber-300",
  ORANGE: "bg-orange-500 dark:bg-orange-400",
  RED: "bg-red-500 dark:bg-red-400",
  PINK: "bg-pink-500 dark:bg-pink-400",
  PURPLE: "bg-violet-500 dark:bg-violet-400",
};

/** GitHub's option colour as the dot beside a column's name. */
export function columnDotClass(color: string | null): string {
  return (color === null ? undefined : COLUMN_DOT[color]) ?? "bg-transparent ring-1 ring-border";
}
