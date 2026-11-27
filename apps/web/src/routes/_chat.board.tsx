import { createFileRoute } from "@tanstack/react-router";

import { BoardPage, boardSearchFromUrl } from "../components/board/BoardPage";

export const Route = createFileRoute("/_chat/board")({
  validateSearch: boardSearchFromUrl,
  component: BoardPage,
});
