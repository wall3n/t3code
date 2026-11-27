import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { ProjectBoardError, type ProjectBoardState } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    state: null as unknown,
    canLaunch: true,
    canMove: true,
    launch: vi.fn(),
    move: vi.fn(),
    alert: vi.fn(),
    navigate: vi.fn(),
    dispatch: vi.fn(),
    goBack: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  ScrollView: Children,
  Alert: { alert: mocks.alert },
  Pressable: ({
    children,
    disabled,
    onPress,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <div role="button" aria-disabled={disabled} onClick={disabled ? undefined : onPress}>
      {children}
    </div>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    navigate: mocks.navigate,
    dispatch: mocks.dispatch,
    goBack: mocks.goBack,
  }),
  StackActions: { push: (name: string, params: unknown) => ({ name, params }) },
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ environmentId: "env-1", id: "p1", title: "App" }],
}));
vi.mock("../../state/projectBoards", () => ({
  projectBoardEnvironment: {
    state: () => ({}),
    refresh: "refresh",
    move: "move",
    launch: "launch",
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: mocks.state, error: null, refresh: () => {} }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_environmentId: string, scope: string) =>
    scope === "orchestration:operate" ? mocks.canLaunch : mocks.canMove,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "launch" ? mocks.launch : command === "move" ? mocks.move : vi.fn(),
}));
vi.mock("../layout/workspace/ListFilterMenu", () => ({
  ListFilterMenu: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/RefreshControl", () => ({ RefreshControl: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: ({ title }: { title: string }) => <p>{title}</p>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));

import { BoardRouteScreen } from "./BoardRouteScreen";

const entry = {
  boardId: "b1",
  host: "github.com",
  title: "Roadmap",
  number: 1,
  owner: "acme",
  url: "https://x",
};
const item = (over: Record<string, unknown>) => ({
  id: "i1",
  kind: "issue",
  title: "Fix login",
  url: "https://x",
  repository: "acme/app",
  number: 7,
  state: "open",
  columnId: "todo",
  assignees: [],
  labels: [],
  linkedPullRequests: [],
  threadIds: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

function boardState(items: unknown[], boards: unknown[] = [entry]) {
  return {
    projectId: "p1",
    boards,
    boardId: "b1",
    board: {
      summary: {
        id: "b1",
        number: 1,
        title: "Roadmap",
        url: "https://x",
        owner: "acme",
        closed: false,
      },
      host: "github.com",
      statusFieldId: "status",
      columns: [
        { id: null, name: "No Status", color: null, description: "" },
        { id: "todo", name: "Todo", color: "BLUE", description: "" },
        { id: "done", name: "Done", color: "GREEN", description: "" },
      ],
      items,
      truncated: false,
    },
    sync: { status: "live", syncedAt: null, error: null, webhookDeliveredAt: null },
    viewers: 1,
    revision: 1,
  } as unknown as ProjectBoardState;
}

let root: Root;
let container: HTMLDivElement;

const render = (state: unknown) => {
  mocks.state = state;
  act(() =>
    root.render(
      <BoardRouteScreen route={{ params: { environmentId: "env-1", projectId: "p1" } }} />,
    ),
  );
};
const button = (text: string) =>
  [...container.querySelectorAll<HTMLElement>("button")].find((el) => el.textContent === text);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.canLaunch = true;
  mocks.canMove = true;
  for (const fn of [mocks.launch, mocks.move, mocks.alert, mocks.navigate, mocks.dispatch]) {
    fn.mockReset();
  }
  mocks.launch.mockResolvedValue(AsyncResult.success({ threadId: "t-new" }));
});

afterEach(() => {
  act(() => root.unmount());
});

describe("BoardRouteScreen", () => {
  it("shows the empty state when the project has no boards", () => {
    render({ ...boardState([]), boards: [], boardId: null, board: null });
    expect(container.textContent).toContain("No boards on this project yet");
  });

  it("lists columns with counts and hides an empty No Status column", () => {
    render(boardState([item({ id: "i1" }), item({ id: "i2", title: "Add logout", number: 8 })]));
    expect(container.textContent).toContain("Todo · 2");
    expect(container.textContent).toContain("Done · 0");
    expect(container.textContent).not.toContain("No Status");
    expect(container.textContent).toContain("Fix login");
    expect(container.textContent).toContain("Add logout");
  });

  it("starts an agent in a worktree for an open issue and opens the new thread", async () => {
    render(boardState([item({})]));
    await act(async () => button("Start agent")!.click());
    expect(mocks.launch).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { projectId: "p1", boardId: "b1", itemId: "i1", workspace: "worktree" },
    });
    expect(mocks.dispatch).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "env-1", threadId: "t-new" },
    });
  });

  it("offers the existing thread instead of Start agent", () => {
    render(boardState([item({ threadIds: ["t-1"] })]));
    expect(button("Open agent thread")).toBeDefined();
    expect(button("Start agent")).toBeUndefined();
  });

  it("hides Start agent without the operate scope, and for closed issues", () => {
    mocks.canLaunch = false;
    render(boardState([item({})]));
    expect(button("Start agent")).toBeUndefined();
    mocks.canLaunch = true;
    render(boardState([item({ state: "closed" })]));
    expect(button("Start agent")).toBeUndefined();
  });

  it("asks what to do when an agent is already working", async () => {
    const busy = new ProjectBoardError({
      operation: "launch",
      reason: "busy",
      detail: "Already running.",
      threadId: "t-busy" as never,
    });
    mocks.launch.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(busy)));
    render(boardState([item({})]));
    await act(async () => button("Start agent")!.click());

    const [title, detail, actions] = mocks.alert.mock.calls[0]!;
    expect([title, detail]).toEqual(["An agent is already working", "Already running."]);
    expect(actions.map((entry: { text: string }) => entry.text)).toEqual([
      "Open thread",
      "Start another",
      "Cancel",
    ]);
    act(() => actions[0].onPress());
    expect(mocks.dispatch).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "env-1", threadId: "t-busy" },
    });
    await act(async () => actions[1].onPress());
    expect(mocks.launch).toHaveBeenLastCalledWith({
      environmentId: "env-1",
      input: {
        projectId: "p1",
        boardId: "b1",
        itemId: "i1",
        workspace: "worktree",
        force: true,
      },
    });
  });

  it("shows the board switcher only with more than one board", () => {
    render(boardState([]));
    expect(container.textContent).not.toContain("Roadmap");
    render(boardState([], [entry, { ...entry, boardId: "b2", title: "Bugs" }]));
    expect(container.textContent).toContain("Roadmap");
  });

  it("opens the Issue route when an issue card is tapped", () => {
    render(boardState([item({})]));
    act(() => container.querySelector<HTMLElement>('[role="button"]')!.click());
    expect(mocks.navigate).toHaveBeenCalledWith("Issue", {
      environmentId: "env-1",
      projectId: "p1",
      tracker: "github",
      host: "github.com",
      scope: "acme/app",
      issueKey: "7",
    });
  });
});
