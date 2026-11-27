import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { ProjectBoardEntry, ProjectId } from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type ProjectBoardsRepositoryError,
} from "./Errors.ts";

/** The GitHub boards added to each project, oldest first. */
export class ProjectBoardsRepository extends Context.Service<
  ProjectBoardsRepository,
  {
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ProjectBoardEntry>, ProjectBoardsRepositoryError>;
    /** Adds the board, or refreshes its title and owner when the project already has it. */
    readonly upsert: (input: {
      readonly projectId: ProjectId;
      readonly entry: ProjectBoardEntry;
      readonly addedAt: string;
    }) => Effect.Effect<void, ProjectBoardsRepositoryError>;
    readonly remove: (input: {
      readonly projectId: ProjectId;
      readonly boardId: string;
    }) => Effect.Effect<void, ProjectBoardsRepositoryError>;
  }
>()("t3/persistence/ProjectBoards/ProjectBoardsRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const listRows = SqlSchema.findAll({
    Request: ProjectId,
    Result: ProjectBoardEntry,
    execute: (projectId) => sql`
      SELECT board_id AS "boardId", host AS "host", title AS "title", number AS "number",
        owner AS "owner", url AS "url"
      FROM project_boards
      WHERE project_id = ${projectId}
      ORDER BY added_at ASC, board_id ASC
    `,
  });
  return ProjectBoardsRepository.of({
    list: Effect.fn("ProjectBoardsRepository.list")(
      (projectId: ProjectId) => listRows(projectId),
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? PersistenceDecodeError.fromSchemaError("ProjectBoardEntry", cause)
          : new PersistenceSqlError({ operation: "listProjectBoards", cause }),
      ),
    ),
    upsert: Effect.fn("ProjectBoardsRepository.upsert")(
      ({
        projectId,
        entry,
        addedAt,
      }: {
        readonly projectId: ProjectId;
        readonly entry: ProjectBoardEntry;
        readonly addedAt: string;
      }) =>
        sql`
          INSERT INTO project_boards (project_id, board_id, host, title, number, owner, url, added_at)
          VALUES (
            ${projectId}, ${entry.boardId}, ${entry.host}, ${entry.title}, ${entry.number},
            ${entry.owner}, ${entry.url}, ${addedAt}
          )
          ON CONFLICT (project_id, board_id)
          DO UPDATE SET host = excluded.host, title = excluded.title, number = excluded.number,
            owner = excluded.owner, url = excluded.url
        `.pipe(Effect.asVoid),
      Effect.mapError(
        (cause) => new PersistenceSqlError({ operation: "upsertProjectBoard", cause }),
      ),
    ),
    remove: Effect.fn("ProjectBoardsRepository.remove")(
      ({ projectId, boardId }: { readonly projectId: ProjectId; readonly boardId: string }) =>
        sql`DELETE FROM project_boards WHERE project_id = ${projectId} AND board_id = ${boardId}`.pipe(
          Effect.asVoid,
        ),
      Effect.mapError(
        (cause) => new PersistenceSqlError({ operation: "removeProjectBoard", cause }),
      ),
    ),
  });
});

export const layer = Layer.effect(ProjectBoardsRepository, make);
