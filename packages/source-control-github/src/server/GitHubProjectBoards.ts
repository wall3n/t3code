import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GraphQLClient, GraphQLClientError } from "effect/graphql";
import {
  IssueTrackerKind,
  type ProjectBoard,
  type ProjectBoardColumn,
  type ProjectBoardItem,
  type ProjectBoardSummary,
} from "@t3tools/contracts";
import { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";
import type { ProjectBoardApi } from "@t3tools/source-control-core/server/ProjectBoard";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubGraphQlClient from "./gitHubGraphQlClient.ts";
import { reasonFor } from "./GitHubIssueTracker.ts";
import { toActors, toLabels } from "./gitHubIssueJson.ts";
import {
  type ProjectBoardRead,
  type ProjectBoardSummaryFields,
  ProjectBoardsGraphQLGroup,
} from "./projectBoards.graphql.ts";

const KIND = IssueTrackerKind.make("github");
const BOARD_ROWS = 20;
const ITEM_ROWS = 100;
// shortcut: a board reads at most 500 items per sync; page lazily if boards grow past that.
const MAX_ITEM_PAGES = 5;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
const WEBHOOK_EVENTS = ["issues", "pull_request", "issue_comment"];

type BoardNode = Extract<
  NonNullable<ProjectBoardRead.Result["node"]>,
  { readonly __typename: "ProjectV2" }
>;
type ItemNode = NonNullable<NonNullable<BoardNode["items"]["nodes"]>[number]>;

const NO_STATUS: ProjectBoardColumn = {
  id: null,
  name: "No Status",
  color: null,
  description: "",
};

function toBoardSummary(raw: ProjectBoardSummaryFields): ProjectBoardSummary | null {
  const owner = "login" in raw.owner ? raw.owner.login : null;
  const title = raw.title.trim();
  if (owner === null || title.length === 0 || raw.number < 1) return null;
  return { id: raw.id, number: raw.number, title, url: raw.url, owner, closed: raw.closed };
}

function toBoardItem(raw: ItemNode): ProjectBoardItem | null {
  const content = raw.content;
  if (content == null || raw.type === "REDACTED") return null;
  const columnId =
    raw.fieldValueByName?.__typename === "ProjectV2ItemFieldSingleSelectValue"
      ? raw.fieldValueByName.optionId
      : null;
  const base = { id: raw.id, columnId, threadIds: [], updatedAt: raw.updatedAt };
  switch (content.__typename) {
    case "DraftIssue":
      return {
        ...base,
        kind: "draft",
        title: content.title,
        url: null,
        repository: null,
        number: null,
        state: null,
        assignees: toActors(content.assignees.nodes),
        labels: [],
        linkedPullRequests: [],
      };
    case "Issue":
      return {
        ...base,
        kind: "issue",
        title: content.title,
        url: content.url,
        repository: content.repository.nameWithOwner,
        number: content.number,
        state: content.state === "OPEN" ? "open" : "closed",
        assignees: toActors(content.assignees.nodes),
        labels: toLabels(content.labels?.nodes),
        linkedPullRequests: (content.closedByPullRequestsReferences?.nodes ?? []).flatMap((pr) =>
          pr == null
            ? []
            : [
                {
                  repository: pr.repository.nameWithOwner,
                  number: pr.number,
                  title: pr.title,
                  url: pr.url,
                  state: pullRequestState(pr.state),
                  isDraft: pr.isDraft,
                },
              ],
        ),
      };
    case "PullRequest":
      return {
        ...base,
        kind: "pull_request",
        title: content.title,
        url: content.url,
        repository: content.repository.nameWithOwner,
        number: content.number,
        state: pullRequestState(content.pullRequestState),
        assignees: toActors(content.assignees.nodes),
        labels: toLabels(content.labels?.nodes),
        linkedPullRequests: [],
      };
    default:
      return null;
  }
}

function pullRequestState(state: "OPEN" | "CLOSED" | "MERGED") {
  return state === "OPEN" ? "open" : state === "MERGED" ? "merged" : "closed";
}

/** The board from its first page and every item page read, in GitHub's order. */
export function toBoard(
  host: string,
  node: BoardNode,
  items: ReadonlyArray<ItemNode>,
  truncated: boolean,
): ProjectBoard | null {
  const summary = toBoardSummary(node);
  if (summary === null) return null;
  const status = node.field?.__typename === "ProjectV2SingleSelectField" ? node.field : null;
  const columns: ProjectBoardColumn[] = [
    NO_STATUS,
    ...(status?.options ?? []).map((option) => ({
      id: option.id,
      name: option.name.trim() || "Untitled",
      color: option.color,
      description: option.description,
    })),
  ];
  const known = new Set(columns.map((column) => column.id));
  return {
    summary,
    host,
    statusFieldId: status?.id ?? null,
    columns,
    items: items.flatMap((raw) => {
      const item = toBoardItem(raw);
      if (item === null) return [];
      // An option deleted since the item was set reads as no status.
      return [known.has(item.columnId) ? item : { ...item, columnId: null }];
    }),
    truncated,
  };
}

const decodeHooks = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.Number,
        config: Schema.Struct({ url: Schema.optional(Schema.String) }),
      }),
    ),
  ),
);

const group = ProjectBoardsGraphQLGroup.middleware(GitHubGraphQlClient.GitHubGraphQlAuth);

export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const client = yield* GraphQLClient.make(group).pipe(Effect.provide(GitHubGraphQlClient.layer));

  const fail =
    (operation: string, what: string) =>
    (error: GitHubRequestPolicy.GitHubApiError | GraphQLClientError.GraphQLClientError) =>
      new IssueTrackerError({
        tracker: KIND,
        operation,
        reason: reasonFor(error),
        detail: GraphQLClientError.isGraphQLClientError(error)
          ? `GitHub returned an unreadable ${what} response.`
          : reasonFor(error) === "unauthenticated"
            ? "GitHub refused the request. The token needs the `project` scope (run `gh auth refresh -s project`)."
            : `GitHub could not ${what}.`,
        ...("retryAt" in error && error.retryAt !== undefined ? { retryAt: error.retryAt } : {}),
        cause: error,
      });

  const invalid = (operation: string, detail: string, reason: "failed" | "not-found" = "failed") =>
    new IssueTrackerError({ tracker: KIND, operation, reason, detail });

  const graphql =
    (host: string, operation: string, what: string) =>
    <A, E extends GitHubRequestPolicy.GitHubApiError | GraphQLClientError.GraphQLClientError, R>(
      effect: Effect.Effect<A, E, R>,
    ) =>
      effect.pipe(
        GitHubGraphQlClient.call({ host, operation }),
        Effect.mapError(fail(operation, what)),
      );

  const repository = (value: string, operation: string) => {
    const [owner = "", name = ""] = value.split("/");
    return REPOSITORY.test(value) && name !== "." && name !== ".."
      ? Effect.succeed({ owner, name })
      : Effect.fail(invalid(operation, "A repository was named that GitHub cannot address."));
  };

  const listBoards: ProjectBoardApi["listBoards"] = Effect.fn("GitHubProjectBoards.listBoards")(
    function* (input) {
      const { owner, name } = yield* repository(input.repository, "listBoards");
      const result = yield* client
        .ProjectBoardsForRepository({ owner, name, rows: BOARD_ROWS })
        .pipe(graphql(input.host, "listBoards", "list project boards"));
      const repo = result.repository;
      if (repo == null)
        return yield* invalid("listBoards", "GitHub could not find the repository.", "not-found");
      const owned = "projectsV2" in repo.owner ? (repo.owner.projectsV2.nodes ?? []) : [];
      const seen = new Set<string>();
      return [...(repo.projectsV2.nodes ?? []), ...owned].flatMap((raw) => {
        const summary = raw == null ? null : toBoardSummary(raw);
        if (summary === null || seen.has(summary.id)) return [];
        seen.add(summary.id);
        return [summary];
      });
    },
  );

  const readBoard: ProjectBoardApi["readBoard"] = Effect.fn("GitHubProjectBoards.readBoard")(
    function* (input) {
      let first: BoardNode | null = null;
      const items: ItemNode[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_ITEM_PAGES; page++) {
        const result: ProjectBoardRead.Result = yield* client
          .ProjectBoardRead({ id: input.boardId, cursor, rows: ITEM_ROWS })
          .pipe(graphql(input.host, "readBoard", "read the project board"));
        const node = result.node;
        if (node == null || node.__typename !== "ProjectV2") {
          return yield* invalid(
            "readBoard",
            "GitHub could not find the project board.",
            "not-found",
          );
        }
        first ??= node;
        for (const item of node.items.nodes ?? []) if (item != null) items.push(item);
        if (!node.items.pageInfo.hasNextPage) {
          cursor = null;
          break;
        }
        cursor = node.items.pageInfo.endCursor;
        if (cursor === null) break;
      }
      const board = first === null ? null : toBoard(input.host, first, items, cursor !== null);
      if (board === null)
        return yield* invalid("readBoard", "GitHub returned a board without a title or owner.");
      return board;
    },
  );

  const setItemStatus: ProjectBoardApi["setItemStatus"] = Effect.fn(
    "GitHubProjectBoards.setItemStatus",
  )(function* (input) {
    const target = { projectId: input.boardId, itemId: input.itemId, fieldId: input.fieldId };
    const write = graphql(input.host, "setItemStatus", "move the item");
    if (input.optionId === null) yield* write(client.ClearProjectBoardItemStatus(target));
    else yield* write(client.SetProjectBoardItemStatus({ ...target, optionId: input.optionId }));
  });

  const ensureWebhook: ProjectBoardApi["ensureWebhook"] = Effect.fn(
    "GitHubProjectBoards.ensureWebhook",
  )(function* (input) {
    const { owner, name } = yield* repository(input.repository, "ensureWebhook");
    const path = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hooks`;
    const rest = (request: Omit<GitHubRest.GitHubRestInput, "host" | "operation">) =>
      api
        .rest({ host: input.host, operation: "ensureWebhook", ...request })
        .pipe(Effect.mapError(fail("ensureWebhook", "configure the repository webhook")));
    const body = {
      active: true,
      events: WEBHOOK_EVENTS,
      config: { url: input.url, content_type: "json", secret: input.secret, insecure_ssl: "0" },
    };
    const listed = yield* rest({ path: `${path}?per_page=100` });
    const hooks = yield* decodeHooks(listed.body).pipe(
      Effect.mapError(() => invalid("ensureWebhook", "GitHub returned an unreadable hook list.")),
    );
    const existing = hooks.find((hook) => hook.config.url === input.url);
    if (existing !== undefined) {
      yield* rest({ method: "PATCH", path: `${path}/${existing.id}`, body });
      return "updated" as const;
    }
    yield* rest({ method: "POST", path, body: { name: "web", ...body } });
    return "created" as const;
  });

  return { listBoards, readBoard, setItemStatus, ensureWebhook } satisfies ProjectBoardApi;
});
