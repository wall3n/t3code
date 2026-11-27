import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_boards (
      project_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      host TEXT NOT NULL,
      title TEXT NOT NULL,
      number INTEGER NOT NULL,
      owner TEXT NOT NULL,
      url TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (project_id, board_id)
    ) WITHOUT ROWID
  `;
});
