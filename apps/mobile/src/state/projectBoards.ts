import { createProjectBoardEnvironmentAtoms } from "@t3tools/client-runtime/state/projectBoards";

import { connectionAtomRuntime } from "../connection/runtime";

export const projectBoardEnvironment = createProjectBoardEnvironmentAtoms(connectionAtomRuntime);
