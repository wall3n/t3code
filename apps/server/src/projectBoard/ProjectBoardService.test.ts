import type { IssueDetail, ModelSelection, ProjectBoard, ServerProvider } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { boardAgentPrompt } from "./boardAgentPrompt.ts";
import { launchModelSelection, webhookUrl, withItemColumn } from "./ProjectBoardService.ts";

it("builds the webhook URL from the origin alone, and refuses what GitHub must not call", () => {
  expect(webhookUrl("https://t3.example.com/some/path?x=1")).toBe(
    "https://t3.example.com/api/github/webhooks",
  );
  expect(webhookUrl("http://localhost:3773")).toBe("http://localhost:3773/api/github/webhooks");
  expect(webhookUrl("ftp://example.com")).toBeNull();
  expect(webhookUrl("https://user:secret@example.com")).toBeNull();
  expect(webhookUrl("not a url")).toBeNull();
});

it("moves only the named item", () => {
  const board = {
    items: [
      { id: "a", columnId: "todo" },
      { id: "b", columnId: "todo" },
    ],
  } as unknown as ProjectBoard;
  expect(withItemColumn(board, "a", "done").items.map((item) => item.columnId)).toEqual([
    "done",
    "todo",
  ]);
});

it("gives the agent the issue, the latest comments and the closing reference", () => {
  const issue = {
    scope: "acme/app",
    displayKey: "#12",
    title: "Fix login",
    url: "https://github.com/acme/app/issues/12",
    body: "Users bounce back to /login.",
    comments: [
      {
        id: "1",
        author: { login: "octo", name: null, avatarUrl: null },
        body: "Repro on Safari.",
        createdAt: "",
        url: null,
      },
      { id: "2", author: null, body: "   ", createdAt: "", url: null },
    ],
  } as unknown as IssueDetail;
  const prompt = boardAgentPrompt(issue, "Keep the change small.");
  expect(prompt).toContain("Resolve GitHub issue acme/app#12: Fix login");
  expect(prompt).toContain("<issue>\nUsers bounce back to /login.\n</issue>");
  expect(prompt).toContain("- octo: Repro on Safari.");
  expect(prompt).not.toContain("- someone:");
  expect(prompt).toContain("Keep the change small.");
  expect(prompt).toContain('Put "Closes acme/app#12" in the pull request body');
  expect(boardAgentPrompt({ ...issue, body: "", comments: [] }, undefined)).toContain(
    "(The issue has no description.)",
  );
});

it("falls back to the first ready provider when the saved default cannot run", () => {
  const provider = (instanceId: string, driver: string, ready: boolean, models: string[]) =>
    ({
      instanceId,
      driver,
      enabled: true,
      installed: ready,
      status: ready ? "ready" : "error",
      auth: { status: "authenticated" },
      models: models.map((slug) => ({ slug, name: slug })),
    }) as unknown as ServerProvider;
  const providers = [
    provider("codex", "codex", false, []),
    provider("claudeAgent", "claudeAgent", true, ["claude-haiku-5-5", "claude-opus-5-5"]),
  ];
  const codexDefault = { instanceId: "codex", model: "gpt-6" } as ModelSelection;
  expect(launchModelSelection(codexDefault, providers)).toEqual({
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
  });
  const claudeDefault = { instanceId: "claudeAgent", model: "claude-haiku-5-5" } as ModelSelection;
  expect(launchModelSelection(claudeDefault, providers)).toBe(claudeDefault);
  expect(launchModelSelection(null, [providers[0]!])).toBeNull();
});
