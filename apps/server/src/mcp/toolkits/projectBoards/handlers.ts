import type { ProjectBoard, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectBoardService from "../../../projectBoard/ProjectBoardService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  BoardColumnNotFoundError,
  BoardProjectRequiredError,
  ProjectBoardsToolkit,
} from "./tools.ts";

// shortcut: an agent sees at most 200 items per board; page when boards grow past that.
const MAX_ITEMS = 200;

/** What an agent reads of a board: names it can act on, never the raw GitHub shape. */
export function boardRows(board: ProjectBoard) {
  const columnName = new Map(board.columns.map((column) => [column.id, column.name]));
  return {
    boardId: board.summary.id,
    columns: board.columns.map((column) => column.name),
    items: board.items.slice(0, MAX_ITEMS).map((item) => ({
      itemId: item.id,
      kind: item.kind,
      title:
        item.number === null ? item.title : `${item.repository ?? ""}#${item.number} ${item.title}`,
      column: item.columnId === null ? null : (columnName.get(item.columnId) ?? null),
      url: item.url,
      agentThreads: item.threadIds.length,
    })),
    truncated: board.truncated || board.items.length > MAX_ITEMS,
  };
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const boards = yield* ProjectBoardService.ProjectBoardService;

  const projectOf = Effect.fn("ProjectBoardsToolkit.projectOf")(function* (
    requested: ProjectId | undefined,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("issues");
    if (requested !== undefined) return requested;
    const thread =
      scope.thread === undefined
        ? null
        : yield* engine
            .getThreadShell(scope.thread.threadId)
            .pipe(Effect.orElseSucceed(() => null));
    if (thread === null) return yield* new BoardProjectRequiredError();
    return thread.projectId;
  });

  return {
    list_project_boards: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const projectId = yield* projectOf(input.projectId);
        const added = yield* boards.boards(projectId);
        const list = added.map((entry) => ({
          boardId: entry.boardId,
          title: entry.title,
          url: entry.url,
        }));
        if (input.boardId === undefined) return { boards: list };
        const board = yield* boards.snapshot({ projectId, boardId: input.boardId });
        return { boards: list, board: boardRows(board) };
      }),
    ),
    move_board_item: McpToolAccess.writes((input) =>
      Effect.gen(function* () {
        const projectId = yield* projectOf(input.projectId);
        const target = { projectId, boardId: input.boardId };
        const board = yield* boards.snapshot(target);
        const column =
          input.column === null
            ? null
            : board.columns.find(
                (candidate) => candidate.name.toLowerCase() === input.column?.toLowerCase(),
              );
        if (column === undefined)
          return yield* new BoardColumnNotFoundError({
            column: input.column ?? "",
            columns: board.columns.map((candidate) => candidate.name),
          });
        yield* boards.move({ ...target, itemId: input.itemId, columnId: column?.id ?? null });
        return { itemId: input.itemId, column: column?.name ?? null };
      }),
    ),
    start_board_agent: McpToolAccess.startsThreads(
      () => ({}),
      (input, modes) =>
        Effect.gen(function* () {
          const projectId = yield* projectOf(input.projectId);
          return yield* boards.launch(
            {
              projectId,
              boardId: input.boardId,
              itemId: input.itemId,
              workspace: input.workspace ?? "worktree",
              ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
            },
            { runtimeMode: modes.runtimeMode, interactionMode: modes.interactionMode },
          );
        }),
      { refused: "start an agent on a board item" },
    ),
  } satisfies McpToolAccess.Handlers<typeof ProjectBoardsToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(ProjectBoardsToolkit, make);
