import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectBoardError,
  ProjectId,
  type ProjectBoard,
  type ProjectBoardItem,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { useProjects } from "../../state/entities";
import { projectBoardEnvironment } from "../../state/projectBoards";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";

/** Plain strings, so a link can carry them. */
export type BoardParams = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly boardId?: string;
};

const isBoardError = Schema.is(ProjectBoardError);

export function BoardRouteScreen({ route }: StaticScreenProps<BoardParams>) {
  return (
    <BoardRoute
      key={`${route.params.environmentId} ${route.params.projectId}`}
      params={route.params}
    />
  );
}

function BoardRoute({ params }: { params: BoardParams }) {
  const gt = useGT();
  const navigation = useNavigation();
  const bottomInset = useSafeAreaInsets().bottom;
  const environmentId = EnvironmentId.make(params.environmentId);
  const projectId = ProjectId.make(params.projectId);
  const project = useProjects().find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  const [boardId, setBoardId] = useState(params.boardId);
  const query = useEnvironmentQuery(
    projectBoardEnvironment.state({
      environmentId,
      input: boardId === undefined ? { projectId } : { projectId, boardId },
    }),
  );
  const refresh = useAtomCommand(projectBoardEnvironment.refresh, { reportFailure: false });
  const state = query.data;
  const board = state?.board ?? null;
  const shown = state?.boards.find((entry) => entry.boardId === state.boardId);

  return (
    <View className="flex-1 bg-screen">
      <AppBar
        title={shown?.title ?? gt("Board", { $context: "screen title, a GitHub project board" })}
        subtitle={project?.title ?? null}
        onBack={() => navigation.goBack()}
        {...(state?.boardId == null
          ? {}
          : {
              refresh: {
                accessibilityLabel: gt("Sync with GitHub now"),
                onPress: () =>
                  void refresh({
                    environmentId,
                    input: { projectId, boardId: state.boardId! },
                  }),
              },
            })}
      />
      {state === null ? (
        query.error !== null ? (
          <EmptyState
            title={gt("The board could not be opened")}
            detail={query.error}
            actionLabel={gt("Try again")}
            onAction={query.refresh}
          />
        ) : (
          <View className="flex-1 items-center justify-center">
            <AppActivityIndicator />
          </View>
        )
      ) : state.boards.length === 0 ? (
        <EmptyState
          title={gt("No boards on this project yet")}
          detail={gt("Add a GitHub board to the project from T3 Code on the web or desktop.")}
        />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: bottomInset + 24 }}
          refreshControl={<RefreshControl refreshing={false} onRefresh={query.refresh} />}
        >
          {state.boards.length > 1 ? (
            <View className="flex-row px-4 pt-3">
              <ListFilterMenu
                label={shown?.title ?? ""}
                accessibilityLabel={gt("Choose a board")}
                actions={state.boards.map((entry) => ({
                  id: entry.boardId,
                  title: entry.title,
                  state: entry.boardId === state.boardId ? "on" : "off",
                }))}
                onSelect={setBoardId}
              />
            </View>
          ) : null}
          {board === null ? (
            state.sync.status === "error" ? (
              <EmptyState
                title={gt("GitHub did not return the board")}
                detail={state.sync.error ?? gt("The request failed.")}
              />
            ) : (
              <View className="items-center py-12">
                <AppActivityIndicator />
              </View>
            )
          ) : (
            <BoardColumns
              board={board}
              environmentId={environmentId}
              projectId={projectId}
              boardId={state.boardId!}
            />
          )}
        </ScrollView>
      )}
    </View>
  );
}

function BoardColumns({
  board,
  environmentId,
  projectId,
  boardId,
}: {
  board: ProjectBoard;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  boardId: string;
}) {
  const canMove =
    useEnvironmentScope(environmentId, AuthSourceControlWriteScope) && board.statusFieldId !== null;
  const canLaunch = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  return (
    <View className="gap-6 px-4 pt-4">
      {board.columns.map((column) => {
        const items = board.items.filter((item) => item.columnId === column.id);
        if (column.id === null && items.length === 0) return null;
        return (
          <View key={column.id ?? ""} className="gap-2">
            <Text textRole="footnote" className="font-t3-bold text-foreground-muted">
              {column.name} · {items.length}
            </Text>
            {items.map((item) => (
              <BoardCard
                key={item.id}
                item={item}
                board={board}
                environmentId={environmentId}
                projectId={projectId}
                boardId={boardId}
                canMove={canMove}
                canLaunch={canLaunch}
              />
            ))}
          </View>
        );
      })}
    </View>
  );
}

function BoardCard({
  item,
  board,
  environmentId,
  projectId,
  boardId,
  canMove,
  canLaunch,
}: {
  item: ProjectBoardItem;
  board: ProjectBoard;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  boardId: string;
  canMove: boolean;
  canLaunch: boolean;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const move = useAtomCommand(projectBoardEnvironment.move, { reportFailure: false });
  const launch = useAtomCommand(projectBoardEnvironment.launch, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const latestThread = item.threadIds[0];
  const openThread = (threadId: string) =>
    navigation.dispatch(
      StackActions.push("Thread", { environmentId: String(environmentId), threadId }),
    );

  const start = async (force: boolean) => {
    setPending(true);
    const result = await launch({
      environmentId,
      input: {
        projectId,
        boardId,
        itemId: item.id,
        workspace: "worktree",
        ...(force ? { force } : {}),
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      openThread(result.value.threadId);
      return;
    }
    const failure = squashAtomCommandFailure(result);
    if (isBoardError(failure) && failure.reason === "busy" && failure.threadId !== undefined) {
      const working = failure.threadId;
      Alert.alert(gt("An agent is already working"), failure.detail, [
        { text: gt("Open thread"), onPress: () => openThread(working) },
        { text: gt("Start another"), onPress: () => void start(true) },
        { text: gt("Cancel"), style: "cancel" },
      ]);
      return;
    }
    Alert.alert(
      gt("Could not start the agent"),
      isBoardError(failure) ? failure.detail : gt("The server refused it."),
    );
  };

  const moveTo = async (columnId: string | null) => {
    const result = await move({
      environmentId,
      input: { projectId, boardId, itemId: item.id, columnId },
    });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      Alert.alert(
        gt("Could not move the item"),
        isBoardError(failure) ? failure.detail : gt("GitHub refused the move."),
      );
    }
  };

  return (
    <Pressable
      accessibilityRole="button"
      disabled={item.kind !== "issue" || item.repository === null || item.number === null}
      onPress={() =>
        item.repository !== null && item.number !== null
          ? navigation.navigate("Issue", {
              environmentId: String(environmentId),
              projectId: String(projectId),
              tracker: "github",
              host: board.host,
              scope: item.repository,
              issueKey: String(item.number),
            })
          : undefined
      }
      className="gap-2 rounded-2xl bg-surface p-4 active:opacity-80"
    >
      <Text textRole="label" className="text-foreground-muted">
        {item.repository === null
          ? gt("Draft")
          : `${item.repository}${item.number === null ? "" : ` #${item.number}`}`}
      </Text>
      <Text textRole="body" className="text-foreground">
        {item.title || gt("Untitled")}
      </Text>
      <View className="flex-row flex-wrap items-center gap-2">
        {latestThread !== undefined ? (
          <Button
            size="compact"
            tone="text"
            icon="bubble.left"
            label={gt("Open agent thread")}
            onPress={() => openThread(latestThread)}
          />
        ) : canLaunch && item.kind === "issue" && item.state === "open" ? (
          <Button
            size="compact"
            tone="secondary"
            icon="play"
            label={gt("Start agent")}
            loading={pending}
            onPress={() => void start(false)}
          />
        ) : null}
        {canMove ? (
          <ListFilterMenu
            label={gt("Move")}
            accessibilityLabel={gt("Move to column")}
            actions={board.columns.map((column) => ({
              id: column.id ?? "",
              title: column.name,
              state: column.id === item.columnId ? "on" : "off",
            }))}
            onSelect={(id) => void moveTo(id === "" ? null : id)}
          />
        ) : null}
      </View>
    </Pressable>
  );
}
