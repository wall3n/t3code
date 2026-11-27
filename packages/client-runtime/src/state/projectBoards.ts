import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * A project's GitHub board. The server pushes the whole board on every change, so a write needs
 * no refresh: the subscription carries its result to every client.
 */
export function createProjectBoardEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  // Moves stay in click order per board; moves on other boards do not wait for them.
  const serialPerBoard = {
    mode: "serial",
    key: ({
      environmentId,
      input,
    }: {
      readonly environmentId: string;
      readonly input: { readonly projectId: string };
    }) => `${environmentId} ${input.projectId}`,
  } as const;
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:project-boards:state",
      tag: WS_METHODS.projectBoardsSubscribe,
      idleTtlMs: 30_000,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:project-boards:list",
      tag: WS_METHODS.projectBoardsList,
    }),
    add: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-boards:add",
      tag: WS_METHODS.projectBoardsAdd,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-boards:remove",
      tag: WS_METHODS.projectBoardsRemove,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-boards:refresh",
      tag: WS_METHODS.projectBoardsRefresh,
    }),
    move: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-boards:move",
      tag: WS_METHODS.projectBoardsMove,
      scheduler,
      concurrency: serialPerBoard,
    }),
    launch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-boards:launch",
      tag: WS_METHODS.projectBoardsLaunch,
    }),
    configureWebhooks: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-boards:configure-webhooks",
      tag: WS_METHODS.projectBoardsConfigureWebhooks,
    }),
  };
}
