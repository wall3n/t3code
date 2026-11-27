import { expect, it } from "vite-plus/test";

import { toBoard } from "./GitHubProjectBoards.ts";

const node = {
  __typename: "ProjectV2" as const,
  id: "PVT_1",
  number: 3,
  title: "Roadmap",
  url: "https://github.com/users/acme/projects/3",
  closed: false,
  owner: { __typename: "User" as const, login: "acme" },
  field: {
    __typename: "ProjectV2SingleSelectField" as const,
    id: "F_status",
    options: [
      { id: "todo", name: "Todo", color: "GRAY" as const, description: "Not started" },
      { id: "doing", name: "In Progress", color: "YELLOW" as const, description: "" },
    ],
  },
  items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
};

const assignees = { nodes: [{ login: "octo", name: null, avatarUrl: "https://a/octo" }] };

it("maps issues, pull requests and drafts into the board's columns", () => {
  const board = toBoard(
    "github.com",
    node,
    [
      {
        id: "I_1",
        type: "ISSUE",
        updatedAt: "2026-11-27T10:00:00Z",
        fieldValueByName: { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "doing" },
        content: {
          __typename: "Issue",
          number: 12,
          title: "Fix login",
          url: "https://github.com/acme/app/issues/12",
          state: "OPEN",
          updatedAt: "2026-11-27T10:00:00Z",
          repository: { nameWithOwner: "acme/app" },
          assignees,
          labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
          closedByPullRequestsReferences: {
            nodes: [
              {
                number: 31,
                title: "Fix login redirect",
                url: "https://github.com/acme/app/pull/31",
                state: "MERGED",
                isDraft: false,
                repository: { nameWithOwner: "acme/app" },
              },
            ],
          },
        },
      },
      {
        id: "I_2",
        type: "DRAFT_ISSUE",
        updatedAt: "2026-11-27T10:00:00Z",
        // An option deleted since it was set reads as no status.
        fieldValueByName: { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "gone" },
        content: {
          __typename: "DraftIssue",
          title: "Idea",
          updatedAt: "2026-11-27T10:00:00Z",
          assignees: { nodes: [] },
        },
      },
      {
        id: "I_3",
        type: "REDACTED",
        updatedAt: "2026-11-27T10:00:00Z",
        fieldValueByName: null,
        content: null,
      },
    ],
    false,
  );
  expect(board?.columns.map((column) => column.id)).toEqual([null, "todo", "doing"]);
  expect(board?.statusFieldId).toBe("F_status");
  expect(board?.items).toHaveLength(2);
  const [issue, draft] = board!.items;
  expect(issue).toMatchObject({
    kind: "issue",
    columnId: "doing",
    repository: "acme/app",
    number: 12,
    state: "open",
    labels: [{ name: "bug", color: "d73a4a" }],
    linkedPullRequests: [{ number: 31, state: "merged" }],
    threadIds: [],
  });
  expect(issue?.assignees[0]?.login).toBe("octo");
  expect(draft).toMatchObject({ kind: "draft", columnId: null, url: null, repository: null });
});

it("refuses a board GitHub returned without an owner login", () => {
  expect(
    toBoard("github.com", { ...node, owner: { __typename: "Bot" } as never }, [], false),
  ).toBeNull();
});
