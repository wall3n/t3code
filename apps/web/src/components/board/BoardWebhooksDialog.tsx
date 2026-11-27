import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ProjectBoardState, ProjectBoardWebhookResult } from "@t3tools/contracts";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { msg, T, useGT } from "gt-react";
import { useState } from "react";

import { m } from "~/i18n/messages";
import { projectBoardEnvironment } from "~/state/projectBoards";
import { useAtomCommand } from "~/state/use-atom-command";

import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import type { ProjectTarget } from "./BoardCard";

const isLocalOrigin = (origin: string) => /\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(origin);

/** Points the board's repositories at this server so GitHub changes arrive in seconds. */
export function BoardWebhooksDialog({
  target,
  state,
  onClose,
}: {
  target: ProjectTarget;
  state: ProjectBoardState;
  onClose: () => void;
}) {
  const gt = useGT();
  const configure = useAtomCommand(projectBoardEnvironment.configureWebhooks, {
    reportFailure: false,
  });
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const [publicUrl, setPublicUrl] = useState(isLocalOrigin(origin) ? "" : origin);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProjectBoardWebhookResult | null>(null);

  const submit = async () => {
    setPending(true);
    setError(null);
    const answer = await configure({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, publicUrl },
    });
    setPending(false);
    if (answer._tag === "Success") setResult(answer.value);
    else
      setError(
        readableFailure(squashAtomCommandFailure(answer), m(msg("GitHub refused the request."))),
      );
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-lg">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <T>Set up webhooks</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                Without webhooks the board checks GitHub every 20 seconds while someone has it open.
                With them, issue and pull request changes arrive within a second. GitHub must reach
                this server from the internet, for example through a tunnel.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="board-webhook-url">
                  <T>Public address of this server</T>
                </Label>
                <Input
                  id="board-webhook-url"
                  type="url"
                  required
                  value={publicUrl}
                  placeholder="https://t3.example.com"
                  onChange={(event) => setPublicUrl(event.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                  <T>
                    T3 adds a hook to each repository on the board, signed with a secret only this
                    server holds. Running it again updates the same hooks.
                  </T>
                </p>
              </div>
              {error !== null ? (
                <p role="alert" className="text-destructive-foreground text-sm">
                  {error}
                </p>
              ) : null}
              {result !== null ? (
                <ul className="flex flex-col gap-1.5 text-sm" aria-label={gt("Webhook results")}>
                  {result.repositories.map((repository) => (
                    <li key={repository.repository} className="flex items-start gap-2">
                      {repository.status === "failed" ? (
                        <CircleAlertIcon
                          aria-hidden
                          className="mt-0.5 size-4 shrink-0 text-destructive-foreground"
                        />
                      ) : (
                        <CircleCheckIcon
                          aria-hidden
                          className="mt-0.5 size-4 shrink-0 text-success"
                        />
                      )}
                      <span className="min-w-0">
                        <span className="font-medium">{repository.repository}</span>{" "}
                        <span className="text-muted-foreground">
                          {repository.status === "created"
                            ? gt("Hook added.")
                            : repository.status === "updated"
                              ? gt("Hook updated.")
                              : (repository.detail ?? gt("GitHub refused the hook."))}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {state.sync.webhookDeliveredAt !== null ? (
                <p className="text-muted-foreground text-xs">
                  {gt("The last delivery arrived at {time}.", {
                    time: new Date(state.sync.webhookDeliveredAt).toLocaleTimeString(),
                  })}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {result === null ? gt("Cancel") : gt("Done")}
            </Button>
            <Button type="submit" disabled={pending || publicUrl.trim() === ""}>
              {pending ? gt("Adding hooks…") : gt("Add webhooks")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
