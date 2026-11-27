import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type ProjectBoardColumn,
  type ProjectBoardEntry,
  type ProjectBoardItem,
  type ProjectBoardState,
} from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  KanbanSquareIcon,
  PlusIcon,
  SettingsIcon,
  UnplugIcon,
  UsersIcon,
  WebhookIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useEffect, useState } from "react";

import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { projectBoardEnvironment, useProjectBoardState } from "~/state/projectBoards";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useEnvironmentQuery } from "~/state/query";
import { isElectron } from "~/env";

import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { PullRequestSearchInput } from "../pullRequest/PullRequestListFilters";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { toastManager } from "../ui/toast";
import { BoardCard, type BoardCardTarget, type ProjectTarget } from "./BoardCard";
import { BoardWebhooksDialog } from "./BoardWebhooksDialog";
import {
  applyPendingMoves,
  boardColumns,
  columnDotClass,
  columnDropId,
  columnIdFromDropId,
  matchesBoardQuery,
  settlePendingMoves,
  type BoardColumnView,
  type PendingMove,
} from "./board.logic";

export interface BoardSearch {
  readonly environment?: string | undefined;
  readonly project?: string | undefined;
  readonly board?: string | undefined;
  readonly q?: string | undefined;
}

const bounded = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;

export const boardSearchFromUrl = (raw: Record<string, unknown>): BoardSearch => ({
  environment: bounded(raw.environment),
  project: bounded(raw.project),
  board: bounded(raw.board),
  q: bounded(raw.q),
});

const LAST_BOARD_KEY = "t3code:board:last-project";

function rememberBoard(environmentId: string, projectId: string) {
  try {
    localStorage.setItem(LAST_BOARD_KEY, JSON.stringify({ environmentId, projectId }));
  } catch {
    // A private window keeps no last board; the first project opens instead.
  }
}

function readLastBoard(): { environmentId: string; projectId: string } | null {
  try {
    const raw = localStorage.getItem(LAST_BOARD_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return parsed !== null &&
      typeof parsed === "object" &&
      "environmentId" in parsed &&
      "projectId" in parsed &&
      typeof parsed.environmentId === "string" &&
      typeof parsed.projectId === "string"
      ? { environmentId: parsed.environmentId, projectId: parsed.projectId }
      : null;
  } catch {
    return null;
  }
}

const LAST_PROJECT_BOARDS_KEY = "t3code:board:last-boards";

/** The board each project last showed on this device, so returning opens it again. */
function readProjectBoards(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAST_PROJECT_BOARDS_KEY) ?? "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  } catch {
    return {};
  }
}

function rememberProjectBoard(projectKey: string, boardId: string | undefined) {
  try {
    const boards = readProjectBoards();
    if (boardId === undefined) delete boards[projectKey];
    else boards[projectKey] = boardId;
    localStorage.setItem(LAST_PROJECT_BOARDS_KEY, JSON.stringify(boards));
  } catch {
    // A private window keeps no last board; the project's first board opens instead.
  }
}

// Columns win over cards: a card under the pointer is inside the column it would drop into.
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : rectIntersection(args);
};

export function BoardPage() {
  const gt = useGT();
  const navigate = useNavigate({ from: "/board" });
  const search = useSearch({ from: "/_chat/board" });
  const projects = useProjects().filter((project) => project.isScratch !== true);
  const lastBoard = readLastBoard();
  const selected =
    projects.find(
      (project) => project.environmentId === search.environment && project.id === search.project,
    ) ??
    projects.find(
      (project) =>
        project.environmentId === lastBoard?.environmentId && project.id === lastBoard.projectId,
    ) ??
    projects[0] ??
    null;
  const projectTarget: ProjectTarget | null =
    selected === null ? null : { environmentId: selected.environmentId, projectId: selected.id };
  const projectKey =
    projectTarget === null ? "" : `${projectTarget.environmentId} ${projectTarget.projectId}`;
  const requestedBoard = search.board ?? readProjectBoards()[projectKey];

  const board = useProjectBoardState(
    projectTarget === null ? null : { ...projectTarget, boardId: requestedBoard },
  );
  const state = board.state;
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  // The board a viewer asked for may be gone, or not chosen yet: show the project's first.
  const shownBoard =
    state === null
      ? requestedBoard
      : state.boardId !== null && state.boards.some((entry) => entry.boardId === state.boardId)
        ? state.boardId
        : state.boards[0]?.boardId;
  const showBoard = useStableCallback((boardId: string | undefined) => {
    rememberProjectBoard(projectKey, boardId);
    void navigate({ search: (prev) => ({ ...prev, board: boardId }), replace: true });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the URL on the board the server shows after another viewer adds or removes one
  useEffect(() => {
    if (state !== null && shownBoard !== requestedBoard) showBoard(shownBoard);
  }, [state, shownBoard, requestedBoard, showBoard]);
  const target: BoardCardTarget | null =
    projectTarget === null ||
    state === null ||
    state.boardId === null ||
    shownBoard !== state.boardId
      ? null
      : { ...projectTarget, boardId: state.boardId };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <WorkspaceBreadcrumb ariaLabel={gt("Board breadcrumb")}>
            <WorkspaceBreadcrumbItem>
              <h1 className="truncate">
                <T context="page title, a kanban board of GitHub project items">Board</T>
              </h1>
            </WorkspaceBreadcrumbItem>
            {projects.length > 0 && selected !== null ? (
              <WorkspaceBreadcrumbItem current>
                <Menu open={projectMenuOpen} onOpenChange={setProjectMenuOpen}>
                  <MenuTrigger
                    aria-label={gt("Choose a project")}
                    render={<Button size="xs" variant="ghost" className="-mx-1.5 max-w-64" />}
                  >
                    <span className="truncate">{selected.title}</span>
                    <ChevronDownIcon aria-hidden className="opacity-60" />
                  </MenuTrigger>
                  <MenuPopup align="start">
                    <MenuRadioGroup
                      value={`${selected.environmentId} ${selected.id}`}
                      onValueChange={(value) => {
                        const [environment = "", project = ""] = String(value).split(" ");
                        rememberBoard(environment, project);
                        setProjectMenuOpen(false);
                        void navigate({
                          search: (prev) => ({ ...prev, environment, project, board: undefined }),
                        });
                      }}
                    >
                      {projects.map((project) => (
                        <MenuRadioItem
                          key={`${project.environmentId} ${project.id}`}
                          value={`${project.environmentId} ${project.id}`}
                        >
                          {project.title}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </Menu>
              </WorkspaceBreadcrumbItem>
            ) : null}
            {projectTarget !== null && state !== null && state.boards.length > 0 ? (
              <WorkspaceBreadcrumbItem current>
                <BoardSwitcher
                  target={projectTarget}
                  boards={state.boards}
                  shownBoard={shownBoard}
                  onShow={showBoard}
                />
              </WorkspaceBreadcrumbItem>
            ) : null}
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          {state !== null && target !== null ? (
            <div
              className="flex items-center gap-1 [-webkit-app-region:no-drag]"
              data-workspace-titlebar-controls
            >
              <SyncStatus state={state} />
              <BoardMenu target={target} state={state} />
            </div>
          ) : null}
        </WorkspacePageHeader>

        {projectTarget === null ? (
          <BoardEmpty
            title={gt("No projects yet")}
            description={gt("Add a project whose repository is on GitHub to see its board here.")}
          />
        ) : board.error !== null && state === null ? (
          <BoardEmpty
            title={gt("The board could not be opened")}
            description={board.error}
            action={
              <Button variant="outline" onClick={board.retry}>
                <T>Try again</T>
              </Button>
            }
          />
        ) : state === null ? (
          <BoardSkeleton />
        ) : state.boards.length === 0 ? (
          <BoardPicker key={projectKey} target={projectTarget} onAdded={showBoard} />
        ) : target === null ? (
          <BoardSkeleton />
        ) : state.board === null ? (
          state.sync.status === "error" ? (
            <BoardEmpty
              title={gt("GitHub did not return the board")}
              description={state.sync.error ?? gt("The request failed.")}
              action={<RefreshButton target={target} />}
            />
          ) : (
            <BoardSkeleton />
          )
        ) : (
          <BoardColumns target={target} state={state} query={search.q ?? ""} />
        )}
      </div>
    </SidebarInset>
  );
}

function BoardColumns({
  target,
  state,
  query,
}: {
  target: BoardCardTarget;
  state: ProjectBoardState;
  query: string;
}) {
  const gt = useGT();
  const navigate = useNavigate({ from: "/board" });
  const board = state.board!;
  const canMove =
    useEnvironmentScope(target.environmentId, AuthSourceControlWriteScope) &&
    board.statusFieldId !== null;
  const canLaunch = useEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope);
  const move = useAtomCommand(projectBoardEnvironment.move, { reportFailure: false });
  const [pending, setPending] = useState<ReadonlyMap<string, PendingMove>>(new Map());
  const [dragging, setDragging] = useState<ProjectBoardItem | null>(null);
  const settled = settlePendingMoves(pending, state.revision);
  if (settled !== pending) setPending(settled);

  const items = applyPendingMoves(board.items, settled).filter((item) =>
    matchesBoardQuery(item, query),
  );
  const columns = boardColumns(board, items);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const moveItem = async (item: ProjectBoardItem, columnId: string | null) => {
    if (item.columnId === columnId) return;
    setPending((current) => new Map(current).set(item.id, { columnId, revision: state.revision }));
    const result = await move({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, boardId: target.boardId, itemId: item.id, columnId },
    });
    if (result._tag === "Failure") {
      setPending((current) => {
        const next = new Map(current);
        next.delete(item.id);
        return next;
      });
      toastManager.add({
        type: "error",
        title: m(msg("Could not move the item")),
        description: readableFailure(
          squashAtomCommandFailure(result),
          m(msg("GitHub refused the move.")),
        ),
      });
    }
  };

  const itemTitle = (data: Record<string, unknown> | undefined) =>
    (data?.item as ProjectBoardItem | undefined)?.title ?? "";
  const columnName = (dropId: string | number | undefined) => {
    const id = dropId === undefined ? undefined : columnIdFromDropId(String(dropId));
    return board.columns.find((column) => column.id === id)?.name ?? "";
  };

  const onDragStart = (event: DragStartEvent) => {
    const item = event.active.data.current?.item as ProjectBoardItem | undefined;
    setDragging(item ?? null);
  };
  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const item = event.active.data.current?.item as ProjectBoardItem | undefined;
    const columnId = event.over === null ? undefined : columnIdFromDropId(String(event.over.id));
    if (item !== undefined && columnId !== undefined) void moveItem(item, columnId);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3 sm:px-6">
        <div className="min-w-48 max-w-md flex-1">
          <PullRequestSearchInput
            value={query}
            label={gt("Filter the board")}
            placeholder={gt("Filter by title, #number, label or assignee")}
            onChange={(q) => void navigate({ search: (prev) => ({ ...prev, q: q || undefined }) })}
            onSubmit={(q) => void navigate({ search: (prev) => ({ ...prev, q: q || undefined }) })}
          />
        </div>
        <span className="text-muted-foreground text-xs tabular-nums">
          {gt("{count, plural, one {{count} item} other {{count} items}}", { count: items.length })}
        </span>
        {board.truncated ? (
          <span className="text-warning-foreground text-xs">
            <T>Showing the first 500 items.</T>
          </span>
        ) : null}
        {!canMove && board.statusFieldId === null ? (
          <span className="text-muted-foreground text-xs">
            <T>This board has no Status field, so items cannot move.</T>
          </span>
        ) : null}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
        accessibility={{
          announcements: {
            onDragStart: ({ active }) =>
              gt("Picked up {title}.", { title: itemTitle(active.data.current) }),
            onDragOver: ({ active, over }) =>
              gt("{title} is over {column}.", {
                title: itemTitle(active.data.current),
                column: columnName(over?.id),
              }),
            onDragEnd: ({ active, over }) =>
              over === null
                ? gt("{title} was not moved.", { title: itemTitle(active.data.current) })
                : gt("{title} moved to {column}.", {
                    title: itemTitle(active.data.current),
                    column: columnName(over.id),
                  }),
            onDragCancel: ({ active }) =>
              gt("Moving {title} was cancelled.", { title: itemTitle(active.data.current) }),
          },
          screenReaderInstructions: {
            draggable: gt(
              "Press space or enter to pick up the item. Use the arrow keys to move it, space or enter to drop it, and escape to cancel.",
            ),
          },
        }}
      >
        <div
          className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-4 pb-4 sm:snap-none sm:px-6"
          role="list"
          aria-label={gt("Board columns")}
        >
          {columns.map((view) => (
            <BoardColumn
              key={view.column.id ?? ""}
              view={view}
              target={target}
              columns={board.columns}
              canMove={canMove}
              canLaunch={canLaunch}
              draggingId={dragging?.id ?? null}
              onMove={moveItem}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={{ duration: 160, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}>
          {dragging !== null ? (
            <div className="w-72 rotate-1 cursor-grabbing shadow-lg/10">
              <BoardCard
                target={target}
                item={dragging}
                columns={board.columns}
                canMove={false}
                canLaunch={false}
                onMove={() => undefined}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </>
  );
}

function BoardColumn({
  view,
  target,
  columns,
  canMove,
  canLaunch,
  draggingId,
  onMove,
}: {
  view: BoardColumnView;
  target: BoardCardTarget;
  columns: ReadonlyArray<ProjectBoardColumn>;
  canMove: boolean;
  canLaunch: boolean;
  draggingId: string | null;
  onMove: (item: ProjectBoardItem, columnId: string | null) => void;
}) {
  const { column, items } = view;
  const { setNodeRef, isOver } = useDroppable({ id: columnDropId(column.id) });
  return (
    <section
      ref={setNodeRef}
      role="listitem"
      aria-label={column.name}
      className={cn(
        "flex w-[min(18rem,calc(100vw-3rem))] shrink-0 snap-start flex-col rounded-xl bg-muted/40 transition-colors duration-150 dark:bg-muted/25",
        isOver && "bg-accent/70 ring-1 ring-ring/40 ring-inset dark:bg-accent/50",
      )}
    >
      <header className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span
          aria-hidden
          className={cn("size-2.5 shrink-0 rounded-full", columnDotClass(column.color))}
        />
        <h2 className="min-w-0 truncate font-medium text-sm">{column.name}</h2>
        <span className="text-muted-foreground text-xs tabular-nums">{items.length}</span>
      </header>
      <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {items.map((item) => (
          <BoardCard
            key={item.id}
            target={target}
            item={item}
            columns={columns}
            canMove={canMove}
            canLaunch={canLaunch}
            dragging={item.id === draggingId}
            onMove={onMove}
          />
        ))}
      </div>
    </section>
  );
}

/** Live means GitHub's latest answer is on screen; viewers counts every open board. */
function SyncStatus({ state }: { state: ProjectBoardState }) {
  const gt = useGT();
  const resolve = useMessages();
  const now = Date.parse(useNowMinute());
  const { status, syncedAt, error, webhookDeliveredAt } = state.sync;
  const label =
    status === "error"
      ? gt("Sync failed")
      : status === "syncing"
        ? gt("Syncing…")
        : gt("Live", { $context: "status, the board updates in real time" });
  const details = [
    error,
    syncedAt === null
      ? null
      : gt("GitHub checked {time}.", { time: formatRelativeTimeLabel(syncedAt, now, resolve) }),
    webhookDeliveredAt === null
      ? gt("No webhook delivered yet; the board checks GitHub every 20 seconds while open.")
      : gt("Last webhook {time}.", {
          time: formatRelativeTimeLabel(webhookDeliveredAt, now, resolve),
        }),
  ].filter((line): line is string => line !== null);
  return (
    <SharedTooltipTrigger
      render={
        <span
          role="status"
          className="inline-flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground text-xs"
        />
      }
      label={
        <span className="flex max-w-64 flex-col gap-0.5">
          {details.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      }
    >
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          status === "error"
            ? "bg-destructive"
            : status === "syncing"
              ? "bg-warning motion-safe:animate-status-pulse"
              : "bg-success",
        )}
      />
      <span className={cn(status === "error" && "text-destructive-foreground")}>{label}</span>
      {state.viewers > 1 ? (
        <span
          className="inline-flex items-center gap-1 tabular-nums"
          aria-label={gt("{count} people viewing", { count: state.viewers })}
        >
          <UsersIcon aria-hidden className="size-3.5" />
          {state.viewers}
        </span>
      ) : null}
    </SharedTooltipTrigger>
  );
}

function RefreshButton({ target }: { target: BoardCardTarget }) {
  const gt = useGT();
  const refresh = useAtomCommand(projectBoardEnvironment.refresh);
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={gt("Sync with GitHub now")}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await refresh({
          environmentId: target.environmentId,
          input: { projectId: target.projectId, boardId: target.boardId },
        });
        setPending(false);
      }}
    >
      <RefreshIcon size="md" refreshing={pending} />
    </Button>
  );
}

function BoardMenu({ target, state }: { target: BoardCardTarget; state: ProjectBoardState }) {
  const gt = useGT();
  const canConfigure = useEnvironmentScope(target.environmentId, AuthSettingsWriteScope);
  const [webhooksOpen, setWebhooksOpen] = useState(false);
  const board = state.board;
  return (
    <>
      <RefreshButton target={target} />
      <Menu>
        <MenuTrigger
          aria-label={gt("Board settings")}
          render={<Button size="icon-sm" variant="ghost" />}
        >
          <SettingsIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end">
          {board !== null ? (
            <MenuItem render={<a href={board.summary.url} target="_blank" rel="noreferrer" />}>
              <ExternalLinkIcon aria-hidden />
              <T>
                Open “<Var>{board.summary.title}</Var>” on GitHub
              </T>
            </MenuItem>
          ) : null}
          {canConfigure ? (
            <MenuItem onClick={() => setWebhooksOpen(true)}>
              <WebhookIcon aria-hidden />
              <T>Set up webhooks…</T>
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
      {webhooksOpen ? (
        <BoardWebhooksDialog target={target} state={state} onClose={() => setWebhooksOpen(false)} />
      ) : null}
    </>
  );
}

/** Switches the board this viewer sees, and adds or removes the project's boards for everyone. */
function BoardSwitcher({
  target,
  boards,
  shownBoard,
  onShow,
}: {
  target: ProjectTarget;
  boards: ReadonlyArray<ProjectBoardEntry>;
  shownBoard: string | undefined;
  onShow: (boardId: string | undefined) => void;
}) {
  const gt = useGT();
  const canConfigure = useEnvironmentScope(target.environmentId, AuthSettingsWriteScope);
  const remove = useAtomCommand(projectBoardEnvironment.remove, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProjectBoardEntry | null>(null);
  const [pending, setPending] = useState(false);
  const shown = boards.find((entry) => entry.boardId === shownBoard) ?? boards[0];

  const confirmRemove = async () => {
    if (removing === null) return;
    setPending(true);
    const answer = await remove({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, boardId: removing.boardId },
    });
    setPending(false);
    if (answer._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("Could not remove the board")),
        description: readableFailure(
          squashAtomCommandFailure(answer),
          m(msg("The server refused it.")),
        ),
      });
      return;
    }
    if (removing.boardId === shownBoard) onShow(undefined);
    setRemoving(null);
  };

  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          aria-label={gt("Choose a board")}
          render={<Button size="xs" variant="ghost" className="-mx-1.5 max-w-72" />}
        >
          <KanbanSquareIcon aria-hidden className="opacity-70" />
          <span className="truncate">{shown?.title}</span>
          <ChevronDownIcon aria-hidden className="opacity-60" />
        </MenuTrigger>
        <MenuPopup align="start" className="min-w-56">
          <MenuRadioGroup
            value={shown?.boardId ?? ""}
            onValueChange={(value) => {
              setOpen(false);
              onShow(String(value));
            }}
          >
            {boards.map((entry) => (
              <MenuRadioItem key={entry.boardId} value={entry.boardId}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{entry.title}</span>
                  <span className="truncate text-muted-foreground text-xs">
                    {entry.owner} · #{entry.number}
                  </span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          {canConfigure ? (
            <>
              <MenuSeparator />
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  setAdding(true);
                }}
              >
                <PlusIcon aria-hidden />
                <T>Add a board…</T>
              </MenuItem>
              {shown !== undefined ? (
                <MenuItem
                  onClick={() => {
                    setOpen(false);
                    setRemoving(shown);
                  }}
                >
                  <UnplugIcon aria-hidden />
                  <T>
                    Remove “<Var>{shown.title}</Var>” from this project
                  </T>
                </MenuItem>
              ) : null}
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      {adding ? (
        <Dialog open onOpenChange={setAdding}>
          <DialogPopup className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                <T>Add a board</T>
              </DialogTitle>
              <DialogDescription>
                <T>Everyone connected to this server can switch to the boards you add.</T>
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <AvailableBoards
                target={target}
                added={boards}
                onAdded={(boardId) => {
                  setAdding(false);
                  onShow(boardId);
                }}
              />
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(next) => (next ? undefined : setRemoving(null))}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {gt("Remove “{title}” from this project?", { title: removing?.title ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                Everyone connected to this server loses the board from their switcher. The board
                stays on GitHub, and you can add it again at any time.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={pending}
              render={<Button variant="outline" disabled={pending} />}
            >
              <T>Cancel</T>
            </AlertDialogClose>
            <Button variant="destructive" disabled={pending} onClick={() => void confirmRemove()}>
              <T>Remove board</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** The first visit to a project: add the board it shows. */
function BoardPicker({
  target,
  onAdded,
}: {
  target: ProjectTarget;
  onAdded: (boardId: string) => void;
}) {
  return (
    <div className="scrollbar-gutter-both flex flex-1 justify-center overflow-y-auto px-4 py-10">
      <div className="flex w-full max-w-lg flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold text-lg">
            <T>Add a board to this project</T>
          </h2>
          <p className="text-muted-foreground text-sm">
            <T>
              Everyone connected to this server sees the boards you add. You can add more later and
              switch between them.
            </T>
          </p>
        </div>
        <AvailableBoards target={target} added={[]} onAdded={onAdded} />
      </div>
    </div>
  );
}

/** The repository's GitHub boards that the project does not show yet. */
function AvailableBoards({
  target,
  added,
  onAdded,
}: {
  target: ProjectTarget;
  added: ReadonlyArray<ProjectBoardEntry>;
  onAdded: (boardId: string) => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const list = useEnvironmentQuery(
    projectBoardEnvironment.list({
      environmentId: target.environmentId,
      input: { projectId: target.projectId },
    }),
    resolve,
  );
  const add = useAtomCommand(projectBoardEnvironment.add, { reportFailure: false });
  const canAdd = useEnvironmentScope(target.environmentId, AuthSettingsWriteScope);
  const [pending, setPending] = useState<string | null>(null);
  const result = list.data;

  const choose = async (boardId: string) => {
    setPending(boardId);
    const answer = await add({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, boardId },
    });
    setPending(null);
    if (answer._tag === "Success") {
      onAdded(answer.value.boardId);
      return;
    }
    toastManager.add({
      type: "error",
      title: m(msg("Could not add that board")),
      description: readableFailure(
        squashAtomCommandFailure(answer),
        m(msg("GitHub refused the request.")),
      ),
    });
  };

  if (result === null && list.error !== null)
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p className="text-destructive-foreground">{list.error}</p>
        <Button variant="outline" size="sm" onClick={list.refresh}>
          <T>Try again</T>
        </Button>
      </div>
    );
  if (result === null)
    return (
      <div className="flex flex-col gap-2" aria-busy aria-label={gt("Loading boards")}>
        {SKELETON_ROWS.map((row) => (
          <Skeleton key={row} className="h-12" />
        ))}
      </div>
    );
  const addedIds = new Set(added.map((entry) => entry.boardId));
  const open = result.boards.filter((board) => !board.closed && !addedIds.has(board.id));
  if (open.length === 0)
    return (
      <div className="flex flex-col items-start gap-3 text-sm">
        <p className="text-muted-foreground">
          {added.length > 0
            ? gt("Every board of {repository} is already on this project.", {
                repository: result.repository,
              })
            : gt(
                "{repository} has no boards yet. Create a project on GitHub and link it to the repository.",
                { repository: result.repository },
              )}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            render={
              <a
                href={`https://${result.host}/${result.repository.split("/")[0]}?tab=projects`}
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            <ExternalLinkIcon aria-hidden />
            <T>Open projects on GitHub</T>
          </Button>
          <Button variant="ghost" size="sm" onClick={list.refresh} disabled={list.isPending}>
            <T>Check again</T>
          </Button>
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y rounded-lg border">
        {open.map((board) => (
          <li key={board.id} className="flex items-center gap-3 px-3 py-2.5">
            <KanbanSquareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium text-sm">{board.title}</span>
              <span className="text-muted-foreground text-xs">
                {board.owner} · #{board.number}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!canAdd || pending !== null}
              onClick={() => void choose(board.id)}
            >
              {pending === board.id ? gt("Adding…") : gt("Add board", { $context: "button" })}
            </Button>
          </li>
        ))}
      </ul>
      {!canAdd ? (
        <p className="text-muted-foreground text-xs">
          <T>Only someone who can change settings on this server can add boards.</T>
        </p>
      ) : null}
    </div>
  );
}

const SKELETON_ROWS = ["row-1", "row-2", "row-3"];

const SKELETON_COLUMNS = [5, 3, 4, 2].map((count, column) => ({
  id: `column-${column}`,
  cards: Array.from({ length: count }, (_, card) => `card-${column}-${card}`),
}));

function BoardSkeleton() {
  const gt = useGT();
  return (
    <div
      className="flex min-h-0 flex-1 gap-3 overflow-hidden px-4 pt-11 pb-4 sm:px-6"
      aria-busy
      aria-label={gt("Loading the board")}
    >
      {SKELETON_COLUMNS.map((column) => (
        <div
          key={column.id}
          className="flex w-72 shrink-0 flex-col gap-2 rounded-xl bg-muted/40 p-2 dark:bg-muted/25"
        >
          <Skeleton className="mx-1 my-1.5 h-4 w-24" />
          {column.cards.map((card) => (
            <Skeleton key={card} className="h-20" />
          ))}
        </div>
      ))}
    </div>
  );
}

function BoardEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <KanbanSquareIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action === undefined ? null : <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
