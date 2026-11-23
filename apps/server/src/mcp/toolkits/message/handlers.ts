import { TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { dispatchFailure, newCommandId } from "../../threadAccess.ts";
import { MessageToolkit } from "./tools.ts";

const handlers = {
  send_to_user: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "send_to_user");
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const commandId = yield* newCommandId();
      yield* threads
        .dispatch({
          type: "sent_message.record",
          commandId,
          threadId: thread.threadId,
          runId: null,
          nodeId: null,
          turnItemId: TurnItemId.make(`turn-item:sent-message:${commandId}`),
          text: input.message,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return {
        sentMessage: input.message,
        message: "Shown to the user. Don't repeat it.",
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof MessageToolkit.tools>;

export const layer = McpToolAccess.toLayer(MessageToolkit, handlers);
