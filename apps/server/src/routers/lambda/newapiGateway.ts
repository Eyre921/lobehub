import { z } from 'zod';

import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { isNewApiGatewayEnabled, NewApiGatewayService } from '@/server/services/newapiGateway';

const gatewayProcedure = authedProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;

  return opts.next({
    ctx: {
      newapiGatewayService: new NewApiGatewayService(ctx.serverDB),
    },
  });
});

/**
 * Account panel backend for the managed new-api billing gateway: binding
 * state, wallet balance, usable billing groups with their ratios, and the
 * group rebind action. All gateway calls run server-side with the provision
 * credential — the browser never sees a key.
 */
export const newapiGatewayRouter = router({
  getAccount: gatewayProcedure.query(async ({ ctx }) => {
    if (!isNewApiGatewayEnabled()) return { enabled: false as const };

    const overview = await ctx.newapiGatewayService.getAccountOverview(ctx.userId);
    return { enabled: true as const, ...overview };
  }),

  setGroup: gatewayProcedure
    .input(z.object({ group: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (!isNewApiGatewayEnabled()) throw new Error('new-api gateway is not configured');

      const group = await ctx.newapiGatewayService.rebindGroup(ctx.userId, input.group);
      return { group };
    }),
});
