import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { IssueActor, IssueLabel } from "./issue.ts";
import { PullRequestState } from "./pullRequest.ts";

/**
 * A GitHub Projects board (Projects v2) as T3 shows it. One board is bound to one T3 project,
 * whose credentials read it; every client watching that project sees the same server-held copy.
 */
export const ProjectBoardSummary = Schema.Struct({
  /** The board's node id on its host. */
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  /** The user or organization login that owns the board. */
  owner: TrimmedNonEmptyString,
  closed: Schema.Boolean,
});
export type ProjectBoardSummary = typeof ProjectBoardSummary.Type;

/** One option of the board's Status field. `id` null is the column of items with no status. */
export const ProjectBoardColumn = Schema.Struct({
  id: Schema.NullOr(TrimmedNonEmptyString),
  name: TrimmedNonEmptyString,
  /** GitHub's option colour name (`GRAY`, `BLUE`, …), or null for the no-status column. */
  color: Schema.NullOr(TrimmedNonEmptyString),
  description: Schema.String,
});
export type ProjectBoardColumn = typeof ProjectBoardColumn.Type;

export const ProjectBoardItemKind = Schema.Literals(["issue", "pull_request", "draft"]);
export type ProjectBoardItemKind = typeof ProjectBoardItemKind.Type;

export const ProjectBoardLinkedPullRequest = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: Schema.String,
  url: TrimmedNonEmptyString,
  state: PullRequestState,
  isDraft: Schema.Boolean,
});
export type ProjectBoardLinkedPullRequest = typeof ProjectBoardLinkedPullRequest.Type;

export const ProjectBoardItem = Schema.Struct({
  /** The project item's node id, which moves address. */
  id: TrimmedNonEmptyString,
  kind: ProjectBoardItemKind,
  title: Schema.String,
  /** Null for a draft, which lives only on the board. */
  url: Schema.NullOr(TrimmedNonEmptyString),
  /** `owner/name`, null for a draft. */
  repository: Schema.NullOr(TrimmedNonEmptyString),
  number: Schema.NullOr(PositiveInt),
  state: Schema.NullOr(PullRequestState),
  /** The Status option the item sits in, or null when it has none. */
  columnId: Schema.NullOr(TrimmedNonEmptyString),
  assignees: Schema.Array(IssueActor),
  labels: Schema.Array(IssueLabel),
  /** For an issue, the pull requests GitHub says close it. */
  linkedPullRequests: Schema.Array(ProjectBoardLinkedPullRequest),
  /** T3 threads linked to the issue, most recently active first. */
  threadIds: Schema.Array(ThreadId),
  updatedAt: IsoDateTime,
});
export type ProjectBoardItem = typeof ProjectBoardItem.Type;

export const ProjectBoard = Schema.Struct({
  summary: ProjectBoardSummary,
  host: TrimmedNonEmptyString,
  /** The Status field's id, or null for a board without one: such a board cannot move items. */
  statusFieldId: Schema.NullOr(TrimmedNonEmptyString),
  columns: Schema.Array(ProjectBoardColumn),
  items: Schema.Array(ProjectBoardItem),
  /** GitHub holds more items than one sync reads. */
  truncated: Schema.Boolean,
});
export type ProjectBoard = typeof ProjectBoard.Type;

export const ProjectBoardSyncStatus = Schema.Literals(["idle", "syncing", "live", "error"]);
export type ProjectBoardSyncStatus = typeof ProjectBoardSyncStatus.Type;

const BoardId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

/** A board added to a project. A project can hold several; each viewer picks one to see. */
export const ProjectBoardEntry = Schema.Struct({
  boardId: BoardId,
  host: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  number: PositiveInt,
  owner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export type ProjectBoardEntry = typeof ProjectBoardEntry.Type;

/**
 * One board of a project, as a client draws it, with the project's whole board list so every
 * viewer's switcher stays current. Pushed whole whenever either changes.
 */
export const ProjectBoardState = Schema.Struct({
  projectId: ProjectId,
  /** Every board added to the project, oldest first. */
  boards: Schema.Array(ProjectBoardEntry),
  /** The board this state shows, or null while the project has none. */
  boardId: Schema.NullOr(BoardId),
  board: Schema.NullOr(ProjectBoard),
  sync: Schema.Struct({
    status: ProjectBoardSyncStatus,
    syncedAt: Schema.NullOr(IsoDateTime),
    error: Schema.NullOr(TrimmedNonEmptyString),
    /** When a GitHub webhook last reached this server for the board. */
    webhookDeliveredAt: Schema.NullOr(IsoDateTime),
  }),
  /** How many client connections watch this board now. */
  viewers: NonNegativeInt,
  /** Grows with every change, so a client can drop a stale optimistic move. */
  revision: NonNegativeInt,
});
export type ProjectBoardState = typeof ProjectBoardState.Type;

export const ProjectBoardProjectInput = Schema.Struct({ projectId: ProjectId });
export type ProjectBoardProjectInput = typeof ProjectBoardProjectInput.Type;

export const ProjectBoardTarget = Schema.Struct({ projectId: ProjectId, boardId: BoardId });
export type ProjectBoardTarget = typeof ProjectBoardTarget.Type;

export const ProjectBoardSubscribeInput = Schema.Struct({
  projectId: ProjectId,
  /** The board to show; absent, or no longer on the project, shows its first board. */
  boardId: Schema.optional(BoardId),
});
export type ProjectBoardSubscribeInput = typeof ProjectBoardSubscribeInput.Type;

export const ProjectBoardListResult = Schema.Struct({
  host: TrimmedNonEmptyString,
  /** The repository the project is a checkout of, `owner/name`. */
  repository: TrimmedNonEmptyString,
  boards: Schema.Array(ProjectBoardSummary),
});
export type ProjectBoardListResult = typeof ProjectBoardListResult.Type;

export const ProjectBoardMoveInput = Schema.Struct({
  ...ProjectBoardTarget.fields,
  itemId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  /** The Status option to move to; null clears the status. */
  columnId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type ProjectBoardMoveInput = typeof ProjectBoardMoveInput.Type;

export const PROJECT_BOARD_MAX_INSTRUCTIONS = 8_000;

export const ProjectBoardLaunchInput = Schema.Struct({
  ...ProjectBoardTarget.fields,
  itemId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  /** A new git worktree off the project's current branch, or the project's own checkout. */
  workspace: Schema.Literals(["worktree", "root"]),
  /** Extra guidance appended to the issue in the agent's first message. */
  instructions: Schema.optional(
    Schema.String.check(Schema.isMaxLength(PROJECT_BOARD_MAX_INSTRUCTIONS)),
  ),
  /** Start another agent although one is still working on the item. */
  force: Schema.optional(Schema.Boolean),
});
export type ProjectBoardLaunchInput = typeof ProjectBoardLaunchInput.Type;

export const ProjectBoardLaunchResult = Schema.Struct({ threadId: ThreadId });
export type ProjectBoardLaunchResult = typeof ProjectBoardLaunchResult.Type;

export const ProjectBoardWebhookInput = Schema.Struct({
  projectId: ProjectId,
  /** The public origin GitHub can reach this server at, such as a tunnel's. */
  publicUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
});
export type ProjectBoardWebhookInput = typeof ProjectBoardWebhookInput.Type;

export const ProjectBoardWebhookResult = Schema.Struct({
  url: TrimmedNonEmptyString,
  repositories: Schema.Array(
    Schema.Struct({
      repository: TrimmedNonEmptyString,
      status: Schema.Literals(["created", "updated", "failed"]),
      detail: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ProjectBoardWebhookResult = typeof ProjectBoardWebhookResult.Type;

/** The path GitHub delivers webhooks to. Authenticated by its HMAC signature, not a session. */
export const PROJECT_BOARD_WEBHOOK_PATH = "/api/github/webhooks";

export class ProjectBoardError extends Schema.TaggedError<ProjectBoardError>()(
  "ProjectBoardError",
  {
    operation: TrimmedNonEmptyString,
    reason: Schema.Literals([
      "unsupported",
      "unbound",
      "not-found",
      "unauthenticated",
      "rate-limited",
      "busy",
      "invalid",
      "failed",
    ]),
    detail: TrimmedNonEmptyString,
    retryAt: Schema.optional(Schema.Number),
    /** For `busy`, the thread already working on the item. */
    threadId: Schema.optional(ThreadId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Project board ${this.operation} failed: ${this.detail}`;
  }
}
