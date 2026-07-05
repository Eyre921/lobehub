import { type ChatCompletionErrorPayload } from '@lobechat/model-runtime';
import { AGENT_RUNTIME_ERROR_SET, AgentRuntimeErrorType } from '@lobechat/model-runtime';
import { ChatErrorType } from '@lobechat/types';
import { ModelProvider } from 'model-bank';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import { createTraceOptions, initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { isNewApiGatewayEnabled, NewApiGatewayService } from '@/server/services/newapiGateway';
import { type ChatStreamPayload } from '@/types/openai/chat';
import { createErrorResponse } from '@/utils/errorResponse';
import { getTracePayload } from '@/utils/trace';

import { resolveValidWorkspaceIdFromRequest } from '../../_utils/workspace';

// If user don't use fluid compute, will build  failed
// this enforce user to enable fluid compute
export const maxDuration = 300;

export const POST = checkAuth(async (req: Request, { params, userId, serverDB }) => {
  const provider = (await params)!.provider!;

  try {
    const workspaceId = await resolveValidWorkspaceIdFromRequest({ req, serverDB, userId });

    // ============  1. init chat model   ============ //
    const modelRuntime = await initModelRuntimeFromDB(serverDB, userId, provider, workspaceId);

    // ============  2. create chat completion   ============ //

    const data = (await req.json()) as ChatStreamPayload;

    const tracePayload = getTracePayload(req);

    let traceOptions = {};
    // If user enable trace
    if (tracePayload?.enabled) {
      traceOptions = createTraceOptions(data, { provider, trace: tracePayload });
    }

    const chatOptions = { user: userId, ...traceOptions, signal: req.signal };

    try {
      return await modelRuntime.chat(data, chatOptions);
    } catch (chatError) {
      // newapi managed mode self-heal: the stored relay key can go stale when
      // the user deletes/disables the managed token on the gateway dashboard.
      // Mint a fresh key and retry this request once before surfacing errors.
      const { errorType } = chatError as ChatCompletionErrorPayload;
      if (
        provider === ModelProvider.NewAPI &&
        errorType === AgentRuntimeErrorType.InvalidProviderAPIKey &&
        isNewApiGatewayEnabled()
      ) {
        await new NewApiGatewayService(serverDB).refreshUserApiKey(userId);
        const retryRuntime = await initModelRuntimeFromDB(serverDB, userId, provider, workspaceId);
        return await retryRuntime.chat(data, chatOptions);
      }
      throw chatError;
    }
  } catch (e) {
    const {
      errorType = ChatErrorType.InternalServerError,
      error: errorContent,
      ...res
    } = e as ChatCompletionErrorPayload;

    const error = errorContent || e;

    const logMethod = AGENT_RUNTIME_ERROR_SET.has(errorType as string) ? 'warn' : 'error';
    // track the error at server side
    // eslint-disable-next-line no-console
    console[logMethod](`Route: [${provider}] ${errorType}:`, error);

    return createErrorResponse(errorType, { error, ...res, provider });
  }
});
