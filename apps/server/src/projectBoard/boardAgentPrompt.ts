import type { IssueDetail } from "@t3tools/contracts";

const MAX_BODY = 20_000;
const MAX_COMMENT = 1_500;
const MAX_COMMENTS = 5;

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;

/** The first message an agent launched from a board card receives. */
export function boardAgentPrompt(issue: IssueDetail, instructions: string | undefined): string {
  const reference = `${issue.scope}${issue.displayKey}`;
  const body = issue.body.trim();
  const comments = issue.comments.slice(-MAX_COMMENTS).flatMap((comment) => {
    const text = comment.body.trim();
    return text.length === 0
      ? []
      : [`- ${comment.author?.login ?? "someone"}: ${clip(text, MAX_COMMENT)}`];
  });
  const extra = instructions?.trim() ?? "";
  return [
    `Resolve GitHub issue ${reference}: ${issue.title}`,
    issue.url,
    "",
    "<issue>",
    body.length > 0 ? clip(body, MAX_BODY) : "(The issue has no description.)",
    "</issue>",
    ...(comments.length > 0 ? ["", "Latest comments:", ...comments] : []),
    ...(extra.length > 0 ? ["", "Instructions from the person who started you:", extra] : []),
    "",
    "When the change is complete:",
    "1. Run the project's relevant checks and fix what fails.",
    "2. Commit the work and open a pull request.",
    `3. Put "Closes ${reference}" in the pull request body, so GitHub links it to the issue.`,
  ].join("\n");
}
