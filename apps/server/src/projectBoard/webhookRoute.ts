import { PROJECT_BOARD_WEBHOOK_PATH } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { verifyWebhookSignature } from "../scheduledTasks/webhookVerification.ts";
import * as ProjectBoardService from "./ProjectBoardService.ts";

// GitHub caps a delivery at 25 MB, but the fields a board needs sit at the top of any payload.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const Delivery = Schema.fromJsonString(
  Schema.Struct({
    repository: Schema.optional(Schema.NullOr(Schema.Struct({ full_name: Schema.String }))),
    projects_v2_item: Schema.optional(
      Schema.NullOr(Schema.Struct({ project_node_id: Schema.optional(Schema.String) })),
    ),
  }),
);
const decodeDelivery = Schema.decodeUnknownOption(Delivery);

const status = (code: number, error?: string) =>
  error === undefined
    ? HttpServerResponse.empty({ status: code })
    : HttpServerResponse.jsonUnsafe({ error }, { status: code });

/**
 * GitHub's webhook deliveries. No session reaches this route: the HMAC signature over the exact
 * body, made with the secret only this server and GitHub hold, is the authentication.
 */
const route = (boards: ProjectBoardService.ProjectBoardService["Service"]) =>
  HttpRouter.add(
    "POST",
    PROJECT_BOARD_WEBHOOK_PATH,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const contentLength = Number(request.headers["content-length"] ?? "0");
      if (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES)
        return status(413, "body_too_large");
      const body = yield* request.arrayBuffer.pipe(
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
        Effect.option,
      );
      if (Option.isNone(body)) return status(413, "body_too_large");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers))
        if (typeof value === "string") headers[name.toLowerCase()] = value;
      const secret = yield* boards.webhookSecret.pipe(Effect.option);
      if (Option.isNone(secret)) return status(503, "unavailable");
      const verified = yield* verifyWebhookSignature({
        signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
        secret: secret.value,
        headers,
        body: body.value,
      });
      if (!verified) return status(401, "invalid_signature");
      const event = headers["x-github-event"] ?? "";
      if (event === "ping") return status(204);
      const payload = decodeDelivery(new TextDecoder().decode(body.value));
      if (Option.isNone(payload)) return status(400, "unreadable_payload");
      yield* boards.receiveWebhook({
        event,
        repository: payload.value.repository?.full_name ?? null,
        boardId: payload.value.projects_v2_item?.project_node_id ?? null,
      });
      return status(202);
    }).pipe(Effect.withSpan("projectBoard.webhook")),
  );

// Takes the service while the routes are built, so it is the one shared with WebSocket clients.
export const layer = Layer.unwrap(Effect.map(ProjectBoardService.ProjectBoardService, route));
