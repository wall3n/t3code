/**
 * GitHub Projects boards, shared by every client of this server. The server reads a bound board
 * once and pushes the same copy to every watching connection; a move or launch from one client
 * reaches the others as soon as GitHub accepts it. GitHub changes arrive by webhook when one is
 * configured, and by a poll while anyone watches (user-owned boards have no board webhooks).
 */
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  isProviderAvailable,
  type ModelSelection,
  type ServerProvider,
  type IssueDetail,
  MessageId,
  PROJECT_BOARD_WEBHOOK_PATH,
  ProjectBoard,
  ProjectBoardError,
  type ProjectBoardEntry,
  type ProjectBoardLaunchInput,
  type ProjectBoardLaunchResult,
  type ProjectBoardListResult,
  type ProjectBoardMoveInput,
  type ProjectBoardState,
  type ProjectBoardTarget,
  type ProjectBoardWebhookResult,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import type { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";
import type { ProjectBoardApi } from "@t3tools/source-control-core/server/ProjectBoard";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as IssueService from "../issue/IssueService.ts";
import { listLinkedIssueThreads } from "../issue/linkedThreads.ts";
import { defaultWorktreeStrategy } from "../mcp/toolkits/project/handlers.ts";
import * as ThreadIssueService from "../orchestration-v2/ThreadIssueService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectBoards from "../persistence/ProjectBoards.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlDrivers from "../sourceControl/builtInDrivers.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { boardAgentPrompt } from "./boardAgentPrompt.ts";

const POLL_INTERVAL = "20 seconds";
const WEBHOOK_SECRET_NAME = "github-project-boards-webhook-secret";
const IN_PROGRESS = /^(in[ -]?progress|doing|working)$/i;

/** One board as the server holds it; `boardId` null is a project that has no board yet. */
interface Entry {
  readonly projectId: ProjectId;
  readonly boardId: string | null;
  state: ProjectBoardState;
  viewers: number;
  syncing: boolean;
  again: boolean;
  /** Bumped by every local write, so a read that started before it is not published over it. */
  writes: number;
  readonly lock: Semaphore.Semaphore;
}

export interface LaunchModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface WebhookDelivery {
  readonly event: string;
  /** `owner/name` of the repository the event is about. */
  readonly repository: string | null;
  /** The board node id of a `projects_v2_item` event. */
  readonly boardId: string | null;
}

export class ProjectBoardService extends Context.Service<
  ProjectBoardService,
  {
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectBoardListResult, ProjectBoardError>;
    /** Adds a board to the project for every viewer; adding one it has refreshes its name. */
    readonly add: (
      input: ProjectBoardTarget,
    ) => Effect.Effect<ProjectBoardEntry, ProjectBoardError>;
    readonly remove: (input: ProjectBoardTarget) => Effect.Effect<void, ProjectBoardError>;
    readonly refresh: (input: ProjectBoardTarget) => Effect.Effect<void, ProjectBoardError>;
    readonly move: (input: ProjectBoardMoveInput) => Effect.Effect<void, ProjectBoardError>;
    readonly launch: (
      input: ProjectBoardLaunchInput,
      /** Modes an agent's MCP call may not exceed; absent uses the project's defaults. */
      modes?: LaunchModes,
    ) => Effect.Effect<ProjectBoardLaunchResult, ProjectBoardError>;
    /** The board as it stands, read from GitHub when nobody is watching it. */
    readonly snapshot: (
      input: ProjectBoardTarget,
    ) => Effect.Effect<ProjectBoard, ProjectBoardError>;
    readonly boards: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ProjectBoardEntry>, ProjectBoardError>;
    readonly configureWebhooks: (input: {
      readonly projectId: ProjectId;
      readonly publicUrl: string;
    }) => Effect.Effect<ProjectBoardWebhookResult, ProjectBoardError>;
    readonly subscribe: (input: {
      readonly projectId: ProjectId;
      readonly boardId?: string | undefined;
    }) => Stream.Stream<ProjectBoardState, ProjectBoardError>;
    /** The HMAC secret GitHub signs deliveries with. */
    readonly webhookSecret: Effect.Effect<string, ProjectBoardError>;
    readonly receiveWebhook: (delivery: WebhookDelivery) => Effect.Effect<void>;
  }
>()("t3/projectBoard/ProjectBoardService") {}

const boardError = (
  operation: string,
  reason: ProjectBoardError["reason"],
  detail: string,
  extra?: { readonly threadId?: ThreadId; readonly cause?: unknown },
) => new ProjectBoardError({ operation, reason, detail, ...extra });

const fromTracker = (operation: string) => (error: IssueTrackerError) =>
  boardError(
    operation,
    error.reason === "missing-tool" ? "unauthenticated" : error.reason,
    error.detail.trim() || "The GitHub request failed.",
    { cause: error },
  );

const fromCause = (operation: string, detail: string) => (cause: unknown) =>
  boardError(operation, "failed", detail, { cause });

// Unchanged reads publish nothing, so idle boards send nothing over the wire.
const boardsEqual = Schema.toEquivalence(ProjectBoard);

const emptyState = (
  projectId: ProjectId,
  boards: ReadonlyArray<ProjectBoardEntry>,
  boardId: string | null,
): ProjectBoardState => ({
  projectId,
  boards,
  boardId,
  board: null,
  sync: { status: "idle", syncedAt: null, error: null, webhookDeliveredAt: null },
  viewers: 0,
  revision: 0,
});

/** `host scope key`, lower-cased like issue links compare. */
const issueKey = (host: string, repository: string, number: number | string) =>
  `${host.toLowerCase()} ${repository.toLowerCase()} ${number}`;

/** Whether a public URL is one GitHub may deliver to: http(s), with no credentials or query. */
export function webhookUrl(publicUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return new URL(PROJECT_BOARD_WEBHOOK_PATH, url.origin).toString();
}

/** Whether a provider can start a turn now. */
const isReady = (provider: ServerProvider) =>
  provider.enabled &&
  provider.installed &&
  provider.status === "ready" &&
  provider.auth.status !== "unauthenticated" &&
  isProviderAvailable(provider);

/**
 * The project's default model when its provider can run, else the first ready provider's own
 * default, as the composer offers on a fresh install where no default is saved yet.
 */
export function launchModelSelection(
  preferred: ModelSelection | null,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const preferredProvider = providers.find(
    (provider) => provider.instanceId === preferred?.instanceId,
  );
  if (preferred !== null && preferredProvider !== undefined && isReady(preferredProvider))
    return preferred;
  for (const provider of providers) {
    if (!isReady(provider)) continue;
    const fallback = DEFAULT_MODEL_BY_PROVIDER[provider.driver];
    const model = provider.models.some((entry) => entry.slug === fallback)
      ? fallback
      : provider.models[0]?.slug;
    if (model !== undefined) return { instanceId: provider.instanceId, model };
  }
  return null;
}

const entryKey = (projectId: ProjectId, boardId: string | null) =>
  `${projectId}\u0000${boardId ?? ""}`;

/** What a project's board list keeps of a board read from GitHub. */
function boardEntryOf(board: ProjectBoard): ProjectBoardEntry {
  return {
    boardId: board.summary.id,
    host: board.host,
    title: board.summary.title,
    number: board.summary.number,
    owner: board.summary.owner,
    url: board.summary.url,
  };
}

/** Items the board now holds, with a local move applied before GitHub's next read shows it. */
export function withItemColumn(
  board: ProjectBoard,
  itemId: string,
  columnId: string | null,
): ProjectBoard {
  return {
    ...board,
    items: board.items.map((item) => (item.id === itemId ? { ...item, columnId } : item)),
  };
}

const make = Effect.gen(function* () {
  const drivers = yield* SourceControlDrivers.SourceControlDrivers;
  const issues = yield* IssueService.IssueService;
  const repository = yield* ProjectBoards.ProjectBoardsRepository;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threadIssues = yield* ThreadIssueService.ThreadIssueService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Effect.scope;
  const changes = yield* PubSub.unbounded<ProjectBoardState>();
  const entries = new Map<string, Entry>();
  const boardLists = new Map<ProjectId, ReadonlyArray<ProjectBoardEntry>>();
  const launching = new Set<string>();
  // Additions and removals of one project's boards apply in order.
  const listLock = Semaphore.makeUnsafe(1);

  const api: ProjectBoardApi | null =
    drivers.find((entry) => entry.driver.kind === "github")?.instance.projectBoards ?? null;

  const requireApi = (operation: string): Effect.Effect<ProjectBoardApi, ProjectBoardError> =>
    api === null
      ? Effect.fail(boardError(operation, "unsupported", "This build cannot read GitHub boards."))
      : Effect.succeed(api);

  const publish = (entry: Entry, next: Omit<ProjectBoardState, "revision" | "viewers">) => {
    entry.state = { ...next, viewers: entry.viewers, revision: entry.state.revision + 1 };
    return PubSub.publish(changes, entry.state).pipe(Effect.asVoid);
  };

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /** The project's boards, read once from the database and kept current by add and remove. */
  const boardsOf = Effect.fn("ProjectBoardService.boardsOf")(function* (projectId: ProjectId) {
    const cached = boardLists.get(projectId);
    if (cached !== undefined) return cached;
    const listed = yield* repository
      .list(projectId)
      .pipe(Effect.mapError(fromCause("boards", "The project's boards could not be read.")));
    boardLists.set(projectId, listed);
    return listed;
  });

  const entryFor = (
    projectId: ProjectId,
    boardId: string | null,
    boards: ReadonlyArray<ProjectBoardEntry>,
  ) => {
    const key = entryKey(projectId, boardId);
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = {
        projectId,
        boardId,
        state: emptyState(projectId, boards, boardId),
        viewers: 0,
        syncing: false,
        again: false,
        writes: 0,
        lock: Semaphore.makeUnsafe(1),
      };
      entries.set(key, entry);
    }
    return entry;
  };

  /** Every viewer of the project, whatever board they watch, sees the new list at once. */
  const publishBoards = Effect.fn("ProjectBoardService.publishBoards")(function* (
    projectId: ProjectId,
    boards: ReadonlyArray<ProjectBoardEntry>,
  ) {
    boardLists.set(projectId, boards);
    for (const entry of entries.values())
      if (entry.projectId === projectId) yield* publish(entry, { ...entry.state, boards });
  });

  /** The project's GitHub repository, which board listings and webhooks are read through. */
  const repositoryOf = (projectId: ProjectId, operation: string) =>
    issues.projectScope(projectId).pipe(
      Effect.mapError((cause) =>
        boardError(operation, "unsupported", "This project has no GitHub repository.", { cause }),
      ),
      Effect.filterOrFail(
        (scope) => scope.tracker === "github",
        () => boardError(operation, "unsupported", "Boards need a project hosted on GitHub."),
      ),
    );

  /** The T3 threads linked to each GitHub issue, newest first; archived threads are left out. */
  const linkedThreads = Effect.gen(function* () {
    const rows = yield* sql<{ id: string; host: string; scope: string; key: string }>`
      SELECT t.thread_id AS id,
        json_extract(link.value, '$.host') AS host,
        json_extract(link.value, '$.scope') AS scope,
        json_extract(link.value, '$.key') AS key
      FROM orchestration_v2_projection_threads AS t
      JOIN json_each(t.payload_json, '$.issues') AS link
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
        AND json_extract(link.value, '$.tracker') = 'github'
      ORDER BY t.updated_at DESC, t.thread_id ASC
    `.pipe(NodeSqliteClient.readOnly);
    const byIssue = new Map<string, ThreadId[]>();
    for (const row of rows) {
      if (!row.host || !row.scope || !row.key) continue;
      const key = issueKey(row.host, row.scope, row.key);
      const list = byIssue.get(key) ?? [];
      list.push(ThreadId.make(row.id));
      byIssue.set(key, list);
    }
    return byIssue;
  });

  const withThreads = (board: ProjectBoard) =>
    linkedThreads.pipe(
      Effect.map((byIssue) => ({
        ...board,
        items: board.items.map((item) =>
          item.kind === "issue" && item.repository !== null && item.number !== null
            ? {
                ...item,
                threadIds: byIssue.get(issueKey(board.host, item.repository, item.number)) ?? [],
              }
            : item,
        ),
      })),
      // A board without thread badges beats no board.
      Effect.catch((cause) =>
        Effect.logWarning("Could not read threads linked to board items", { cause }).pipe(
          Effect.as(board),
        ),
      ),
    );

  const syncOnce = Effect.fn("ProjectBoardService.syncOnce")(function* (entry: Entry) {
    if (entry.boardId === null) return;
    const boards = yield* boardsOf(entry.projectId).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read the project's boards", { cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    if (boards === undefined) return;
    const listed = boards.find((board) => board.boardId === entry.boardId);
    // Removed from the project: its viewers already hold the list without it and move on.
    if (listed === undefined) return;
    const previous = entry.state;
    // Only a first read shows a spinner; a background poll changes nothing a viewer sees.
    if (previous.board === null && previous.sync.status !== "syncing")
      yield* publish(entry, {
        ...previous,
        sync: { ...previous.sync, status: "syncing", error: null },
      });
    const writesBefore = entry.writes;
    const read = yield* requireApi("sync").pipe(
      Effect.flatMap((boardApi) =>
        boardApi
          .readBoard({ host: listed.host, boardId: listed.boardId })
          .pipe(Effect.mapError(fromTracker("sync"))),
      ),
      Effect.flatMap(withThreads),
      Effect.result,
    );
    const syncedAt = yield* now;
    if (read._tag === "Failure") {
      yield* publish(entry, {
        ...entry.state,
        sync: { ...entry.state.sync, status: "error", error: read.failure.detail },
      });
      return;
    }
    // A move landed while GitHub was read; this read may predate it, so read again.
    if (entry.writes !== writesBefore) {
      entry.again = true;
      return;
    }
    // A board renamed on GitHub is renamed in every viewer's switcher.
    const fresh = boardEntryOf(read.success);
    if (fresh.title !== listed.title || fresh.owner !== listed.owner || fresh.url !== listed.url) {
      const addedAt = yield* now;
      yield* repository.upsert({ projectId: entry.projectId, entry: fresh, addedAt }).pipe(
        Effect.andThen(
          publishBoards(
            entry.projectId,
            boards.map((board) => (board.boardId === fresh.boardId ? fresh : board)),
          ),
        ),
        Effect.catch((cause) => Effect.logWarning("Could not rename a project board", { cause })),
      );
    }
    const current = entry.state;
    if (
      current.sync.status === "live" &&
      current.board !== null &&
      boardsEqual(current.board, read.success)
    ) {
      entry.state = { ...current, sync: { ...current.sync, syncedAt } };
      return;
    }
    yield* publish(entry, {
      ...current,
      board: read.success,
      sync: { ...current.sync, status: "live", syncedAt, error: null },
    });
  });

  /** Reads the board now, or once more after the read already running. Never waits for it. */
  const requestSync = Effect.fn("ProjectBoardService.requestSync")((entry: Entry) =>
    Effect.suspend(() => {
      if (entry.boardId === null) return Effect.void;
      if (entry.syncing) {
        entry.again = true;
        return Effect.void;
      }
      entry.syncing = true;
      const loop: Effect.Effect<void> = Effect.suspend(() => {
        entry.again = false;
        return syncOnce(entry).pipe(
          Effect.andThen(Effect.suspend(() => (entry.again ? loop : Effect.void))),
        );
      });
      return loop.pipe(
        Effect.ensuring(Effect.sync(() => (entry.syncing = false))),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    }),
  );

  /** The board's held copy, read first when no viewer has loaded it. */
  const loadedBoard = Effect.fn("ProjectBoardService.loadedBoard")(function* (
    target: ProjectBoardTarget,
    operation: string,
  ) {
    const boards = yield* boardsOf(target.projectId);
    if (!boards.some((board) => board.boardId === target.boardId))
      return yield* boardError(operation, "not-found", "The project has no such board.");
    const entry = entryFor(target.projectId, target.boardId, boards);
    if (entry.state.board === null) yield* syncOnce(entry);
    const board = entry.state.board;
    if (board === null)
      return yield* boardError(
        operation,
        "failed",
        entry.state.sync.error ?? "GitHub did not return the board.",
      );
    return { entry, board };
  });

  const setColumn = Effect.fn("ProjectBoardService.setColumn")(function* (
    entry: Entry,
    board: ProjectBoard,
    itemId: string,
    columnId: string | null,
    operation: string,
  ) {
    if (board.statusFieldId === null)
      return yield* boardError(
        operation,
        "invalid",
        "This board has no Status field to move items in.",
      );
    const boardApi = yield* requireApi(operation);
    yield* boardApi
      .setItemStatus({
        host: board.host,
        boardId: board.summary.id,
        fieldId: board.statusFieldId,
        itemId,
        optionId: columnId,
      })
      .pipe(Effect.mapError(fromTracker(operation)));
    entry.writes++;
    const latest = entry.state.board ?? board;
    yield* publish(entry, { ...entry.state, board: withItemColumn(latest, itemId, columnId) });
  });

  const move: ProjectBoardService["Service"]["move"] = Effect.fn("ProjectBoardService.move")(
    function* (input) {
      const { entry, board } = yield* loadedBoard(input, "move");
      const item = board.items.find((candidate) => candidate.id === input.itemId);
      if (item === undefined)
        return yield* boardError("move", "not-found", "The item is no longer on the board.");
      if (!board.columns.some((column) => column.id === input.columnId))
        return yield* boardError("move", "invalid", "The board has no such column.");
      if (item.columnId === input.columnId) return;
      yield* entry.lock.withPermits(1)(
        setColumn(entry, board, input.itemId, input.columnId, "move"),
      );
    },
  );

  const projectDefaults = Effect.fn("ProjectBoardService.projectDefaults")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(fromCause("launch", "The project could not be read.")));
    if (Option.isNone(project))
      return yield* boardError("launch", "not-found", "The project no longer exists.");
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(fromCause("launch", "Settings could not be read.")),
    );
    return {
      project: project.value,
      settings: resolveProjectSettings(current, projectId, project.value).settings,
    };
  });

  const startAgent = Effect.fn("ProjectBoardService.startAgent")(function* (
    input: ProjectBoardLaunchInput,
    entry: Entry,
    board: ProjectBoard,
    modes: LaunchModes | undefined,
  ) {
    const item = board.items.find((candidate) => candidate.id === input.itemId);
    if (item === undefined)
      return yield* boardError("launch", "not-found", "The item is no longer on the board.");
    if (item.kind !== "issue" || item.url === null || item.repository === null)
      return yield* boardError(
        "launch",
        "invalid",
        item.kind === "draft"
          ? "Convert the draft to an issue before you start an agent on it."
          : "Agents start on issues. Open the pull request's issue instead.",
      );
    // The issue's own repository's project does the work, which need not be the board's.
    const ref = yield* issues
      .resolveUrl(item.url, input.projectId)
      .pipe(Effect.mapError(fromCause("launch", "The issue could not be resolved.")));
    if (!ref.writable)
      return yield* boardError(
        "launch",
        "invalid",
        `No project here is a checkout of ${item.repository}. Add it as a project to start agents on its issues.`,
      );
    const issueRef = {
      projectId: ref.projectId,
      tracker: ref.tracker,
      host: ref.host,
      scope: ref.scope,
      key: ref.key,
    };
    if (input.force !== true) {
      const linked = yield* listLinkedIssueThreads(issueRef).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(fromCause("launch", "The issue's threads could not be read.")),
      );
      const working = linked.threads.find(
        (thread) => !thread.settled && thread.archivedAt === null,
      );
      if (working !== undefined)
        return yield* boardError(
          "launch",
          "busy",
          `"${working.title}" is still working on this issue.`,
          {
            threadId: working.id,
          },
        );
    }
    const issue: IssueDetail = yield* issues
      .detail({ ...issueRef, refresh: true })
      .pipe(Effect.mapError(fromCause("launch", "The issue could not be read from GitHub.")));
    const defaults = yield* projectDefaults(ref.projectId);
    const available = yield* providers.getProviders;
    const modelSelection = launchModelSelection(
      resolveNewThreadModelSelection({
        defaultSelection: defaults.settings.defaultModelSelection,
        fallbackSelection: defaults.settings.fallbackModelSelection,
        providers: available,
        settings: defaults.settings,
        projectId: ref.projectId,
        now: DateTime.toEpochMillis(yield* DateTime.now),
      }).selection ?? null,
      available,
    );
    if (modelSelection === null)
      return yield* boardError(
        "launch",
        "invalid",
        "No agent provider is ready. Sign in to one in Settings → Providers.",
      );
    const worktree =
      input.workspace === "worktree"
        ? yield* defaultWorktreeStrategy(defaults.project.workspaceRoot).pipe(
            Effect.provideService(GitVcsDriver.GitVcsDriver, git),
            Effect.mapError((error) =>
              boardError("launch", "failed", error.message, { cause: error }),
            ),
          )
        : undefined;
    const workspaceStrategy =
      worktree === undefined
        ? ({ type: "root" } as const)
        : { ...worktree, startFromOrigin: defaults.settings.newWorktreesStartFromOrigin };
    const id = yield* random.uuidV4();
    if (workspaceStrategy.type === "worktree")
      yield* launches
        .checkWorktreeBase({ projectId: ref.projectId, workspaceStrategy })
        .pipe(
          Effect.mapError((error) =>
            boardError("launch", "invalid", error.message, { cause: error }),
          ),
        );
    const launched = yield* launches
      .launch({
        commandId: CommandId.make(`board:${id}`),
        threadId: ThreadId.make(id),
        projectId: ref.projectId,
        title: `${issue.displayKey} ${issue.title}`.slice(0, 120),
        titleRenamed: true,
        modelSelection,
        runtimeMode: modes?.runtimeMode ?? defaults.settings.defaultRuntimeMode,
        interactionMode: modes?.interactionMode ?? "default",
        workspaceStrategy,
        initialMessage: {
          messageId: MessageId.make(`board:${id}`),
          text: boardAgentPrompt(issue, input.instructions),
          attachments: [],
        },
        // Modes come only from an agent's MCP call; a person's launch uses the project's own.
        createdBy: modes === undefined ? "user" : "agent",
        creationSource: modes === undefined ? "web" : "mcp",
      })
      .pipe(
        Effect.mapError((error) => boardError("launch", "failed", error.message, { cause: error })),
      );
    yield* threadIssues
      .link({
        threadId: launched.threadId,
        ref: issueRef,
        url: issue.url,
        displayKey: issue.displayKey,
        title: issue.title,
        source: "manual",
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not link a board agent to its issue", { cause }),
        ),
      );
    // Every viewer sees the agent on the card at once, before the next read confirms it.
    const latest = entry.state.board ?? board;
    entry.writes++;
    yield* publish(entry, {
      ...entry.state,
      board: {
        ...latest,
        items: latest.items.map((candidate) =>
          candidate.id === item.id
            ? { ...candidate, threadIds: [launched.threadId, ...candidate.threadIds] }
            : candidate,
        ),
      },
    });
    const inProgress = latest.columns.find(
      (column) => column.id !== null && IN_PROGRESS.test(column.name),
    );
    if (inProgress !== undefined && item.columnId !== inProgress.id)
      yield* setColumn(entry, entry.state.board ?? latest, item.id, inProgress.id, "launch").pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not move a launched item to In Progress", { cause }),
        ),
      );
    return { threadId: launched.threadId };
  });

  const launch: ProjectBoardService["Service"]["launch"] = Effect.fn("ProjectBoardService.launch")(
    function* (input, modes) {
      const { entry, board } = yield* loadedBoard(input, "launch");
      const key = `${input.projectId} ${input.boardId} ${input.itemId}`;
      // Two people pressing Launch together start one agent, not two.
      if (launching.has(key))
        return yield* boardError("launch", "busy", "An agent is already starting on this item.");
      launching.add(key);
      return yield* startAgent(input, entry, board, modes).pipe(
        Effect.ensuring(Effect.sync(() => launching.delete(key))),
      );
    },
  );

  const list: ProjectBoardService["Service"]["list"] = Effect.fn("ProjectBoardService.list")(
    function* (projectId) {
      const project = yield* repositoryOf(projectId, "list");
      const boardApi = yield* requireApi("list");
      const found = yield* boardApi
        .listBoards({ host: project.host, repository: project.scope })
        .pipe(Effect.mapError(fromTracker("list")));
      return { host: project.host, repository: project.scope, boards: found };
    },
  );

  const add: ProjectBoardService["Service"]["add"] = Effect.fn("ProjectBoardService.add")(
    function* (input) {
      const project = yield* repositoryOf(input.projectId, "add");
      const boardApi = yield* requireApi("add");
      // Refuse a board GitHub will not show this server before saving it.
      const read = yield* boardApi
        .readBoard({ host: project.host, boardId: input.boardId })
        .pipe(Effect.mapError(fromTracker("add")));
      const entry = boardEntryOf(read);
      const addedAt = yield* now;
      yield* listLock.withPermits(1)(
        Effect.gen(function* () {
          yield* repository
            .upsert({ projectId: input.projectId, entry, addedAt })
            .pipe(Effect.mapError(fromCause("add", "The board could not be saved.")));
          const boards = yield* repository
            .list(input.projectId)
            .pipe(Effect.mapError(fromCause("add", "The project's boards could not be read.")));
          // The first viewer of the new board sees it at once, without waiting for a read.
          const fresh = entryFor(input.projectId, entry.boardId, boards);
          if (fresh.state.board === null) {
            const board = yield* withThreads(read);
            const syncedAt = yield* now;
            yield* publish(fresh, {
              ...fresh.state,
              boards,
              board,
              sync: { ...fresh.state.sync, status: "live", syncedAt, error: null },
            });
          }
          yield* publishBoards(input.projectId, boards);
        }),
      );
      return entry;
    },
  );

  const remove: ProjectBoardService["Service"]["remove"] = Effect.fn("ProjectBoardService.remove")(
    function* (input) {
      yield* listLock.withPermits(1)(
        Effect.gen(function* () {
          yield* repository
            .remove(input)
            .pipe(Effect.mapError(fromCause("remove", "The board could not be removed.")));
          const boards = yield* repository
            .list(input.projectId)
            .pipe(Effect.mapError(fromCause("remove", "The project's boards could not be read.")));
          yield* publishBoards(input.projectId, boards);
          const key = entryKey(input.projectId, input.boardId);
          if ((entries.get(key)?.viewers ?? 0) === 0) entries.delete(key);
        }),
      );
    },
  );

  const webhookSecret = secrets
    .getOrCreateRandom(WEBHOOK_SECRET_NAME, 32)
    .pipe(
      Effect.map(Hex.encode),
      Effect.mapError(fromCause("webhook", "The webhook secret could not be read.")),
    );

  const configureWebhooks: ProjectBoardService["Service"]["configureWebhooks"] = Effect.fn(
    "ProjectBoardService.configureWebhooks",
  )(function* (input) {
    const url = webhookUrl(input.publicUrl);
    if (url === null)
      return yield* boardError(
        "webhook",
        "invalid",
        "Enter an http or https address without a path.",
      );
    const project = yield* repositoryOf(input.projectId, "webhook");
    const boardApi = yield* requireApi("webhook");
    const secret = yield* webhookSecret;
    const names = new Map<string, string>();
    const items = [...entries.values()]
      .filter((entry) => entry.projectId === input.projectId)
      .flatMap((entry) => entry.state.board?.items ?? []);
    for (const name of [project.scope, ...items.flatMap((item) => item.repository ?? [])])
      names.set(name.toLowerCase(), name);
    const repositories = yield* Effect.forEach(
      [...names.values()],
      (name) =>
        boardApi.ensureWebhook({ host: project.host, repository: name, url, secret }).pipe(
          Effect.map((status) => ({ repository: name, status, detail: null })),
          Effect.catch((error) =>
            Effect.succeed({ repository: name, status: "failed" as const, detail: error.detail }),
          ),
        ),
      { concurrency: 4 },
    );
    return { url, repositories };
  });

  const receiveWebhook: ProjectBoardService["Service"]["receiveWebhook"] = Effect.fn(
    "ProjectBoardService.receiveWebhook",
  )(function* (delivery) {
    const deliveredAt = yield* now;
    const deliveredRepository = delivery.repository?.toLowerCase() ?? null;
    for (const entry of entries.values()) {
      const state = entry.state;
      if (entry.boardId === null) continue;
      const matches =
        (delivery.boardId !== null && delivery.boardId === entry.boardId) ||
        (deliveredRepository !== null &&
          (state.board?.items ?? []).some(
            (item) => item.repository?.toLowerCase() === deliveredRepository,
          ));
      if (!matches) continue;
      yield* publish(entry, { ...state, sync: { ...state.sync, webhookDeliveredAt: deliveredAt } });
      if (entry.viewers > 0) yield* requestSync(entry);
    }
  });

  const subscribe: ProjectBoardService["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so no change is lost.
        const subscription = yield* PubSub.subscribe(changes);
        const boards = yield* boardsOf(input.projectId);
        const chosen = boards.find((board) => board.boardId === input.boardId) ?? boards[0] ?? null;
        const entry = entryFor(input.projectId, chosen?.boardId ?? null, boards);
        entry.viewers++;
        yield* Effect.addFinalizer(() =>
          Effect.suspend(() => {
            entry.viewers--;
            return publish(entry, entry.state);
          }),
        );
        yield* publish(entry, { ...entry.state, boards });
        // The first viewer refreshes what an idle board may have missed.
        if (entry.viewers === 1 || entry.state.sync.syncedAt === null) yield* requestSync(entry);
        return Stream.concat(
          Stream.make(entry.state),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (state) => state.projectId === entry.projectId && state.boardId === entry.boardId,
            ),
          ),
        );
      }),
    );

  // Boards with viewers poll; GitHub sends no webhook for a user-owned board's own fields.
  yield* Effect.forkIn(
    Effect.sync(() => [...entries.values()].filter((entry) => entry.viewers > 0)).pipe(
      Effect.flatMap((watched) => Effect.forEach(watched, requestSync)),
      Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
      Effect.asVoid,
    ),
    scope,
  );

  return ProjectBoardService.of({
    snapshot: Effect.fn("ProjectBoardService.snapshot")(function* (input) {
      return (yield* loadedBoard(input, "read")).board;
    }),
    boards: boardsOf,
    list,
    add,
    remove,
    refresh: Effect.fn("ProjectBoardService.refresh")(function* (input) {
      yield* repositoryOf(input.projectId, "refresh");
      const boards = yield* boardsOf(input.projectId);
      if (!boards.some((board) => board.boardId === input.boardId))
        return yield* boardError("refresh", "not-found", "The project no longer has this board.");
      yield* requestSync(entryFor(input.projectId, input.boardId, boards));
    }),
    move,
    launch,
    configureWebhooks,
    subscribe: (input) => subscribe(input).pipe(Stream.scoped),
    webhookSecret,
    receiveWebhook,
  });
});

export const layer = Layer.effect(ProjectBoardService, make);
