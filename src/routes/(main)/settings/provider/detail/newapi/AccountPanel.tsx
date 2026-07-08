'use client';

import { Flexbox, FormGroup, Icon, Text } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { ExternalLinkIcon, Loader2Icon, RefreshCwIcon, WalletIcon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { buildGroupSelectOptions } from '@/features/NewApiGateway/groupOptions';
import { useNewapiGatewayAccount } from '@/features/NewApiGateway/useAccount';
import { lambdaClient } from '@/libs/trpc/client';
import { useAiInfraStore } from '@/store/aiInfra';

/**
 * Managed billing account panel for the new-api gateway: shows the wallet
 * balance and current billing group of the user's bound gateway account, lets
 * the user switch the billing group (server rebinds the managed relay token —
 * ratios apply immediately, the key never changes), and guides unbound legacy
 * users through account binding. Renders nothing when the deployment doesn't
 * configure the gateway.
 */
const AccountPanel = memo(() => {
  const { t } = useTranslation('modelProvider');
  const [switching, setSwitching] = useState(false);
  const fetchRemoteModelList = useAiInfraStore((s) => s.fetchRemoteModelList);

  const { data, isLoading, mutate } = useNewapiGatewayAccount();

  if (!data || !data.enabled) return null;

  if (!data.bound) {
    return (
      <FormGroup
        gap={16}
        title={t('newapi.account.title')}
        variant={'filled'}
        extra={
          <Button
            icon={<Icon icon={RefreshCwIcon} />}
            loading={isLoading}
            size={'small'}
            onClick={() => mutate()}
          >
            {t('newapi.account.refresh')}
          </Button>
        }
      >
        <Flexbox gap={12} paddingBlock={8}>
          <Text type={'secondary'}>{t('newapi.account.unbound.desc')}</Text>
          {data.portalUrl && (
            <div>
              <Button
                icon={<Icon icon={ExternalLinkIcon} />}
                onClick={() => window.open(data.portalUrl, '_blank')}
              >
                {t('newapi.account.unbound.openPortal')}
              </Button>
            </div>
          )}
        </Flexbox>
      </FormGroup>
    );
  }

  const { account, tokenGroup, portalUrl } = data;
  const balance = (account.quota / account.quotaPerUnit).toFixed(2);
  const used = (account.usedQuota / account.quotaPerUnit).toFixed(2);

  const groupOptions = buildGroupSelectOptions(account.usableGroups, t, { group: account.group });

  const handleGroupChange = async (group: string) => {
    setSwitching(true);
    try {
      await lambdaClient.newapiGateway.setGroup.mutate({ group });
      await mutate();
      // the usable model set follows the billing group on the gateway side
      await fetchRemoteModelList('newapi');
    } finally {
      setSwitching(false);
    }
  };

  return (
    <FormGroup
      gap={16}
      title={t('newapi.account.title')}
      variant={'filled'}
      extra={
        portalUrl ? (
          <Button
            icon={<Icon icon={ExternalLinkIcon} />}
            size={'small'}
            onClick={() => window.open(portalUrl, '_blank')}
          >
            {t('newapi.account.portal')}
          </Button>
        ) : undefined
      }
    >
      <Flexbox gap={16} paddingBlock={8}>
        <Flexbox horizontal align={'center'} gap={8}>
          <Icon icon={WalletIcon} size={18} />
          <Text as={'span'} fontSize={20} weight={600}>
            ${balance}
          </Text>
          <Text type={'secondary'}>{t('newapi.account.used', { amount: `$${used}` })}</Text>
          <Button
            icon={<Icon icon={RefreshCwIcon} />}
            loading={isLoading}
            size={'small'}
            onClick={() => mutate()}
          />
        </Flexbox>
        <Flexbox horizontal align={'center'} gap={12} wrap={'wrap'}>
          <Text type={'secondary'}>{t('newapi.account.group')}</Text>
          {switching && <Icon spin icon={Loader2Icon} size={16} style={{ opacity: 0.5 }} />}
          <Select
            options={groupOptions}
            style={{ minWidth: 280 }}
            value={tokenGroup ?? ''}
            onChange={handleGroupChange}
          />
        </Flexbox>
        <Text fontSize={12} type={'secondary'}>
          {t('newapi.account.billingNote')}
        </Text>
      </Flexbox>
    </FormGroup>
  );
});

export default AccountPanel;
