import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ProjectBoardError,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectBoardService from "../../../projectBoard/ProjectBoardService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Orchestrator.OrchestratorV2,
  ProjectBoardService.ProjectBoardService,
];

export class BoardProjectRequiredError extends Schema.TaggedError<BoardProjectRequiredError>()(
  "BoardProjectRequiredError",
  {},
) {
  override get message(): string {
    return "Pass projectId: this MCP client is not running inside a T3 thread.";
  }
}

export class BoardColumnNotFoundError extends Schema.TaggedError<BoardColumnNotFoundError>()(
  "BoardColumnNotFoundError",
  { column: Schema.String, columns: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The board has no column "${this.column}". Its columns: ${this.columns.join(", ")}.`;
  }
}

const BoardToolError = Schema.Union([
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
  ProjectBoardError,
  BoardProjectRequiredError,
  BoardColumnNotFoundError,
]);

const ProjectInput = {
  projectId: Schema.optional(
    ProjectId.annotate({ description: "Project whose boards to use. Defaults to this thread's." }),
  ),
};

const BoardInput = {
  ...ProjectInput,
  boardId: TrimmedNonEmptyString.annotate({ description: "A boardId from list_project_boards." }),
};

const BoardItemRow = Schema.Struct({
  itemId: Schema.String,
  kind: Schema.String,
  title: Schema.String,
  column: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  agentThreads: Schema.Number,
});

const ListProjectBoardsResult = Schema.Struct({
  boards: Schema.Array(
    Schema.Struct({ boardId: Schema.String, title: Schema.String, url: Schema.String }),
  ),
  board: Schema.optional(
    Schema.Struct({
      boardId: Schema.String,
      columns: Schema.Array(Schema.String),
      items: Schema.Array(BoardItemRow),
      truncated: Schema.Boolean,
    }),
  ),
});

const ListProjectBoardsTool = Tool.make("list_project_boards", {
  description:
    "List the GitHub Projects boards added to a T3 project. Pass boardId to also get that board's columns and items.",
  parameters: Schema.Struct({
    ...ProjectInput,
    boardId: Schema.optional(
      TrimmedNonEmptyString.annotate({ description: "Board whose items to include." }),
    ),
  }),
  success: ListProjectBoardsResult,
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "List project boards")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const MoveBoardItemTool = Tool.make("move_board_item", {
  description: "Move a board item to another column on GitHub.",
  parameters: Schema.Struct({
    ...BoardInput,
    itemId: TrimmedNonEmptyString,
    column: Schema.NullOr(TrimmedNonEmptyString).annotate({
      description: "Column name from list_project_boards, or null for no status.",
    }),
  }),
  success: Schema.Struct({ itemId: Schema.String, column: Schema.NullOr(Schema.String) }),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Move board item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const StartBoardAgentTool = Tool.make("start_board_agent", {
  description:
    "Start an agent thread on an issue of a board. The thread gets the issue as its prompt, is linked to it, and the item moves to In Progress.",
  parameters: Schema.Struct({
    ...BoardInput,
    itemId: TrimmedNonEmptyString,
    workspace: Schema.optional(
      Schema.Literals(["worktree", "root"]).annotate({
        description: "worktree (default) for an isolated branch, root for the project checkout.",
      }),
    ),
    instructions: Schema.optional(Schema.String.check(Schema.isMaxLength(8_000))),
  }),
  success: Schema.Struct({ threadId: ThreadId }),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start agent on board item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ProjectBoardsToolkit = Toolkit.make(
  ListProjectBoardsTool,
  MoveBoardItemTool,
  StartBoardAgentTool,
);
