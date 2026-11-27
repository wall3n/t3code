import { createProjectBoardEnvironmentAtoms } from "@t3tools/client-runtime/state/projectBoards";
import type { EnvironmentId, ProjectBoardState, ProjectId } from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const projectBoardEnvironment = createProjectBoardEnvironmentAtoms(connectionAtomRuntime);

/** The project's board as the server holds it, kept current by the server's pushes. */
export function useProjectBoardState(
  target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly boardId?: string | undefined;
  } | null,
): {
  readonly state: ProjectBoardState | null;
  readonly error: string | null;
  readonly retry: () => void;
} {
  const resolve = useMessages();
  const query = useEnvironmentQuery(
    target === null
      ? null
      : projectBoardEnvironment.state({
          environmentId: target.environmentId,
          input:
            target.boardId === undefined
              ? { projectId: target.projectId }
              : { projectId: target.projectId, boardId: target.boardId },
        }),
    resolve,
  );
  return { state: query.data, error: query.error, retry: query.refresh };
}
