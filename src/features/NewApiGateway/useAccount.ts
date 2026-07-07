import useSWR, { type SWRResponse } from 'swr';

import { lambdaClient } from '@/libs/trpc/client';

/**
 * Shared SWR key for the managed new-api gateway account overview. The settings
 * account panel, the per-conversation billing-group switcher, and the
 * no-channel error card all read through this one key so SWR dedupes them into
 * a single cached fetch.
 */
export const NEWAPI_GATEWAY_ACCOUNT_SWR_KEY = 'newapi-gateway-account';

export type NewapiGatewayAccount = Awaited<
  ReturnType<typeof lambdaClient.newapiGateway.getAccount.query>
>;

export const useNewapiGatewayAccount = (): SWRResponse<NewapiGatewayAccount> =>
  useSWR<NewapiGatewayAccount>(
    NEWAPI_GATEWAY_ACCOUNT_SWR_KEY,
    () => lambdaClient.newapiGateway.getAccount.query(),
    { revalidateOnFocus: false },
  );
