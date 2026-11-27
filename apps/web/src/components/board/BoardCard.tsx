import { useDraggable } from "@dnd-kit/core";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectBoardColumn,
  ProjectBoardItem,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { PROJECT_BOARD_MAX_INSTRUCTIONS, ProjectBoardError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, ExternalLinkIcon, EllipsisIcon, ListTreeIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { memo, useState } from "react";

import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { projectBoardEnvironment } from "~/state/projectBoards";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import {
  PullRequestActorAvatar,
  PullRequestLabelChip,
  PullRequestStateGlyph,
} from "../pullRequest/pullRequestPresentation";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { IssueGlyph, issueStatePresentation } from "../issue/issuePresentation";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { issuesSearchFromUrl } from "../issue/issuesSearch.logic";

const isBoardError = Schema.is(ProjectBoardError);

// Card actions stay quiet until the card is hovered or focused; touch screens always show them.
const REVEAL_ON_CARD_HOVER =
  "inline-flex opacity-0 transition-opacity duration-150 group-focus-within/card:opacity-100 group-hover/card:opacity-100 pointer-coarse:opacity-100 has-[[aria-expanded=true]]:opacity-100";

export interface ProjectTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface BoardCardTarget extends ProjectTarget {
  readonly boardId: string;
}

/** One board item. Draggable between columns; the menu offers the same moves by keyboard. */
function BoardCardImpl({
  target,
  item,
  columns,
  canMove,
  canLaunch,
  dragging = false,
  onMove,
}: {
  target: BoardCardTarget;
  item: ProjectBoardItem;
  columns: ReadonlyArray<ProjectBoardColumn>;
  canMove: boolean;
  canLaunch: boolean;
  dragging?: boolean;
  onMove: (item: ProjectBoardItem, columnId: string | null) => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: item.id,
    data: { item },
    disabled: !canMove,
  });
  const latestThreadId = item.threadIds[0] ?? null;
  const thread = useThreadShell(
    latestThreadId === null
      ? null
      : { environmentId: target.environmentId, threadId: latestThreadId },
  );
  const status = thread === null ? null : resolveThreadStatusPill({ thread });
  const working = status?.pulse === true;
  const reference = item.number === null ? null : `#${item.number}`;
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId: target.environmentId, threadId }),
    });
  const openIssue = () => {
    if (item.repository === null || item.number === null) return;
    void navigate({
      to: "/issues",
      search: issuesSearchFromUrl({
        status: "all",
        selectedEnvironmentId: target.environmentId,
        selectedProjectId: target.projectId,
        tracker: "github",
        scope: item.repository,
        key: String(item.number),
      }),
    });
  };

  return (
    <article
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      aria-label={gt("{reference} {title}", { reference: reference ?? "", title: item.title })}
      data-agent={working ? "working" : undefined}
      className={cn(
        "group/card relative flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground shadow-xs/5 outline-none transition-[border-color,box-shadow,opacity] duration-150",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        canMove && "cursor-grab active:cursor-grabbing",
        // A working agent tints the card's edge, the board's one moving signal besides the dot.
        working ? "border-info/50 bg-info/[0.03]" : "border-border hover:border-foreground/20",
        (isDragging || dragging) && "opacity-40",
      )}
    >
      <header className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
        <ItemGlyph item={item} />
        {item.repository !== null ? (
          <span className="min-w-0 truncate">{item.repository}</span>
        ) : (
          <T context="a draft item that lives only on the board">Draft</T>
        )}
        {reference !== null ? <span className="shrink-0 tabular-nums">{reference}</span> : null}
        <span className="min-w-0 flex-1" />
        <CardMenu
          item={item}
          columns={columns}
          canMove={canMove}
          onMove={(columnId) => onMove(item, columnId)}
          onOpenIssue={item.kind === "issue" ? openIssue : null}
          onOpenThread={latestThreadId === null ? null : () => openThread(latestThreadId)}
        />
      </header>

      <p className="line-clamp-3 font-medium text-sm leading-snug [overflow-wrap:anywhere]">
        {item.title || gt("Untitled")}
      </p>

      {item.labels.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1">
          {item.labels.slice(0, 3).map((label) => (
            <PullRequestLabelChip key={label.name} label={label} />
          ))}
          {item.labels.length > 3 ? (
            <span className="text-muted-foreground text-xs tabular-nums">
              +{item.labels.length - 3}
            </span>
          ) : null}
        </div>
      ) : null}

      <footer className="flex min-h-6 items-center gap-2">
        {latestThreadId !== null ? (
          <AgentStatus
            label={status?.label ?? null}
            colorClass={status?.colorClass ?? "text-muted-foreground"}
            dotClass={status?.dotClass ?? "bg-muted-foreground/60"}
            pulse={working}
            count={item.threadIds.length}
            title={thread?.title ?? null}
            onOpen={() => openThread(latestThreadId)}
          />
        ) : canLaunch && item.kind === "issue" && item.state === "open" ? (
          <LaunchAgentControl target={target} item={item} onLaunched={openThread} />
        ) : null}
        <span className="min-w-0 flex-1" />
        {item.linkedPullRequests.slice(0, 1).map((pr) => (
          <a
            key={pr.url}
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            onPointerDown={(event) => event.stopPropagation()}
            className="inline-flex shrink-0 items-center gap-1 rounded-sm text-muted-foreground text-xs tabular-nums hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={gt("Pull request #{number}: {title}", {
              number: pr.number,
              title: pr.title,
            })}
          >
            <PullRequestStateGlyph state={pr.state} isDraft={pr.isDraft} className="size-3.5" />#
            {pr.number}
          </a>
        ))}
        {item.assignees.length > 0 ? (
          <span className="flex shrink-0 items-center -space-x-1">
            {item.assignees.slice(0, 3).map((assignee) => (
              <PullRequestActorAvatar
                key={assignee.login}
                actor={assignee}
                className="ring-1 ring-card"
              />
            ))}
          </span>
        ) : null}
      </footer>
    </article>
  );
}

export const BoardCard = memo(BoardCardImpl);

function ItemGlyph({ item }: { item: ProjectBoardItem }) {
  const gt = useGT();
  if (item.kind === "pull_request" && item.state !== null)
    return <PullRequestStateGlyph state={item.state} isDraft={false} className="size-3.5" />;
  if (item.kind === "draft")
    return <ListTreeIcon role="img" aria-label={gt("Draft")} className="size-3.5 shrink-0" />;
  const presentation = issueStatePresentation(
    item.state === "closed"
      ? { category: "closed", name: gt("Closed issue") }
      : { category: "open", name: gt("Open issue") },
  );
  return (
    <presentation.Icon
      role="img"
      aria-label={presentation.label}
      className={cn("size-3.5 shrink-0", presentation.toneClassName)}
    />
  );
}

function AgentStatus({
  label,
  colorClass,
  dotClass,
  pulse,
  count,
  title,
  onOpen,
}: {
  label: string | null;
  colorClass: string;
  dotClass: string;
  pulse: boolean;
  count: number;
  title: string | null;
  onOpen: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const text = label === null ? gt("Agent finished") : resolve(label);
  return (
    <SharedTooltipTrigger
      label={title ?? gt("Open the agent's thread")}
      render={
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onOpen}
          aria-label={gt("{status}. Open the agent's thread.", { status: text })}
          className={cn(
            "inline-flex min-w-0 items-center gap-1.5 rounded-sm font-medium text-xs hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
            colorClass,
          )}
        />
      }
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          dotClass,
          pulse && "motion-safe:animate-status-pulse",
        )}
      />
      <span className="truncate">{text}</span>
      {count > 1 ? <span className="text-muted-foreground tabular-nums">+{count - 1}</span> : null}
    </SharedTooltipTrigger>
  );
}

function CardMenu({
  item,
  columns,
  canMove,
  onMove,
  onOpenIssue,
  onOpenThread,
}: {
  item: ProjectBoardItem;
  columns: ReadonlyArray<ProjectBoardColumn>;
  canMove: boolean;
  onMove: (columnId: string | null) => void;
  onOpenIssue: (() => void) | null;
  onOpenThread: (() => void) | null;
}) {
  const gt = useGT();
  return (
    <Menu>
      <span className={cn(REVEAL_ON_CARD_HOVER, "-my-1 -me-1.5")}>
        <MenuTrigger
          onPointerDown={(event) => event.stopPropagation()}
          aria-label={gt("Item actions")}
          render={<Button size="icon-xs" variant="ghost" />}
        >
          <EllipsisIcon aria-hidden />
        </MenuTrigger>
      </span>
      <MenuPopup align="end">
        {canMove ? (
          <MenuSub>
            <MenuSubTrigger>
              <T>Move to</T>
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuRadioGroup
                value={item.columnId ?? ""}
                onValueChange={(value) => onMove(value === "" ? null : String(value))}
              >
                {columns.map((column) => (
                  <MenuRadioItem key={column.id ?? ""} value={column.id ?? ""}>
                    {column.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        {onOpenThread !== null ? (
          <MenuItem onClick={onOpenThread}>
            <BotIcon aria-hidden />
            <T>Open agent thread</T>
          </MenuItem>
        ) : null}
        {onOpenIssue !== null ? (
          <MenuItem onClick={onOpenIssue}>
            <IssueGlyph.issue aria-hidden />
            <T>Open in Issues</T>
          </MenuItem>
        ) : null}
        {item.url !== null ? (
          <>
            <MenuSeparator />
            <MenuItem render={<a href={item.url} target="_blank" rel="noreferrer" />}>
              {item.kind === "pull_request" ? (
                <PullRequestGlyph.pullRequest aria-hidden />
              ) : (
                <ExternalLinkIcon aria-hidden />
              )}
              <T>Open on GitHub</T>
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** Starts an agent on the issue: a new thread whose first message is the issue itself. */
function LaunchAgentControl({
  target,
  item,
  onLaunched,
}: {
  target: BoardCardTarget;
  item: ProjectBoardItem;
  onLaunched: (threadId: ThreadId) => void;
}) {
  const gt = useGT();
  const launch = useAtomCommand(projectBoardEnvironment.launch, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [workspace, setWorkspace] = useState<"worktree" | "root">("worktree");
  const [instructions, setInstructions] = useState("");
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState<{ detail: string; threadId: ThreadId | null } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const start = async (force: boolean) => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    const result = await launch({
      environmentId: target.environmentId,
      input: {
        projectId: target.projectId,
        boardId: target.boardId,
        itemId: item.id,
        workspace,
        ...(instructions.trim() === "" ? {} : { instructions }),
        ...(force ? { force: true } : {}),
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      setOpen(false);
      setBusy(null);
      setInstructions("");
      const threadId = result.value.threadId;
      toastManager.add({
        type: "success",
        title: m(msg("Agent started on #{number}", { number: item.number ?? 0 })),
        actionProps: { children: m(msg("Open thread")), onClick: () => onLaunched(threadId) },
      });
      return;
    }
    const failure = squashAtomCommandFailure(result);
    if (isBoardError(failure) && failure.reason === "busy") {
      setBusy({ detail: failure.detail, threadId: failure.threadId ?? null });
      return;
    }
    // The popover stays open, so the reason shows where the person is looking.
    setFailure(
      isBoardError(failure)
        ? failure.detail
        : readableFailure(failure, m(msg("The server refused it."))),
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setBusy(null);
          setFailure(null);
        }
      }}
    >
      <span className={cn(REVEAL_ON_CARD_HOVER, "-ms-1.5")}>
        <PopoverTrigger
          onPointerDown={(event) => event.stopPropagation()}
          render={<Button size="xs" variant="ghost-muted" />}
        >
          <BotIcon aria-hidden />
          <T>Start agent</T>
        </PopoverTrigger>
      </span>
      <PopoverPopup
        align="start"
        className="w-80"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void start(false);
          }}
        >
          <PopoverTitle>
            <T>Start an agent on this issue</T>
          </PopoverTitle>
          <ToggleGroup
            value={[workspace]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "worktree" || next === "root") setWorkspace(next);
            }}
            variant="outline"
            size="sm"
            aria-label={gt("Where the agent works")}
            className="w-full *:flex-1"
          >
            <ToggleGroupItem value="worktree">
              <T>New worktree</T>
            </ToggleGroupItem>
            <ToggleGroupItem value="root">
              <T>Project checkout</T>
            </ToggleGroupItem>
          </ToggleGroup>
          <Textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            maxLength={PROJECT_BOARD_MAX_INSTRUCTIONS}
            rows={3}
            aria-label={gt("Extra instructions")}
            placeholder={gt("Extra instructions (optional)")}
          />
          {failure !== null ? (
            <p role="alert" className="text-destructive-foreground text-xs">
              {failure}
            </p>
          ) : null}
          {busy !== null ? (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-md bg-warning-surface p-2 text-warning-foreground text-xs"
            >
              <p>{busy.detail}</p>
              <div className="flex gap-2">
                {busy.threadId !== null ? (
                  <Button
                    size="xs"
                    variant="outline"
                    type="button"
                    onClick={() => busy.threadId && onLaunched(busy.threadId)}
                  >
                    <T>Open thread</T>
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  variant="ghost"
                  type="button"
                  disabled={pending}
                  onClick={() => void start(true)}
                >
                  <T>Start another</T>
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">
              <T>Uses the project&apos;s default model.</T>
            </p>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? <Spinner aria-hidden className="size-3.5" /> : <BotIcon aria-hidden />}
              <T>Start agent</T>
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
