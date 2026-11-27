/**
 * The port a forge implements to serve project boards (GitHub Projects v2). The server owns
 * binding, caching and fan-out; a driver only reads and writes the forge.
 */
import type * as Effect from "effect/Effect";
import type { ProjectBoard, ProjectBoardSummary } from "@t3tools/contracts";

import type { IssueTrackerError } from "./IssueTracker.ts";

export interface ProjectBoardApi {
  /** Boards linked to `repository` (`owner/name`) and boards its owner holds, deduplicated. */
  readonly listBoards: (input: {
    readonly host: string;
    readonly repository: string;
  }) => Effect.Effect<ReadonlyArray<ProjectBoardSummary>, IssueTrackerError>;

  /** The whole board. Items carry no `threadIds`: the forge does not know T3's threads. */
  readonly readBoard: (input: {
    readonly host: string;
    readonly boardId: string;
  }) => Effect.Effect<ProjectBoard, IssueTrackerError>;

  /** Sets the item's Status option, or clears it when `optionId` is null. */
  readonly setItemStatus: (input: {
    readonly host: string;
    readonly boardId: string;
    readonly fieldId: string;
    readonly itemId: string;
    readonly optionId: string | null;
  }) => Effect.Effect<void, IssueTrackerError>;

  /**
   * Makes `repository` deliver issue and pull request events to `url`, signed with `secret`.
   * Updates the hook already pointing at `url` instead of adding a second one.
   */
  readonly ensureWebhook: (input: {
    readonly host: string;
    readonly repository: string;
    readonly url: string;
    readonly secret: string;
  }) => Effect.Effect<"created" | "updated", IssueTrackerError>;
}
