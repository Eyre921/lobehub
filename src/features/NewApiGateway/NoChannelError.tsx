'use client';

import { Alert, Flexbox, Icon, Text } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { RotateCcw } from 'lucide-react';
import { memo, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useChatStore } from '@/store/chat';
import { topicSelectors } from '@/store/chat/selectors';

import { buildGroupSelectOptions } from './groupOptions';
import { useNewapiGatewayAccount } from './useAccount';

interface NoChannelErrorProps {
  /** Standard error card to show when the managed gateway doesn't apply. */
  fallback: ReactNode;
  /** Requested model name, surfaced in the headline. */
  model?: string;
  /** Regenerate the failed turn after switching group. */
  onRetry?: () => void;
}

/**
 * Actionable error for a managed new-api conversation whose pinned billing
 * group has no channel for the requested model (upstream `no_available_channel`
 * → {@link AgentRuntimeErrorType.NoAvailableChannel}). Lets the user re-pin this
 * conversation to a group that serves the model and retry in one step, without
 * touching the account default or other conversations. Falls back to the
 * standard error card when the managed gateway is not configured/bound.
 */
const NoChannelError = memo<NoChannelErrorProps>(({ fallback, model, onRetry }) => {
  const { t } = useTranslation('modelProvider');
  const { data, mutate } = useNewapiGatewayAccount();
  const updateTopicMetadata = useChatStore((s) => s.updateTopicMetadata);
  const activeTopicId = useChatStore((s) => s.activeTopicId);
  const currentGroup = useChatStore((s) => topicSelectors.currentTopicMetadata(s)?.group ?? '');
  const currentModel = useChatStore((s) => topicSelectors.currentTopicMetadata(s)?.model);
  const [value, setValue] = useState('');
  const [switching, setSwitching] = useState(false);

  // Only the managed gateway can re-pin a conversation's billing group, and
  // only a real (saved) topic can carry the pin. Anything else keeps the
  // standard error card.
  if (!data || !data.enabled || !data.bound || !activeTopicId) return <>{fallback}</>;

  const options = buildGroupSelectOptions(data.account.usableGroups, t);

  const handleSwitch = async () => {
    if (!value || switching) return;
    setSwitching(true);
    try {
      await updateTopicMetadata(activeTopicId, { group: value });
      await mutate();
      onRetry?.();
    } finally {
      setSwitching(false);
    }
  };

  return (
    <Alert
      showIcon
      type={'secondary'}
      description={
        <Flexbox gap={12} style={{ paddingBlockStart: 4 }}>
          <Text fontSize={13} type={'secondary'}>
            {t('newapi.noChannel.desc')}
          </Text>
          <Flexbox horizontal align={'center'} gap={8} wrap={'wrap'}>
            <Select
              options={options}
              placeholder={t('newapi.noChannel.selectPlaceholder')}
              style={{ minWidth: 220 }}
              value={value}
              onChange={(next: string) => setValue(next)}
            />
            <Button
              disabled={!value}
              icon={<Icon icon={RotateCcw} />}
              loading={switching}
              type={'primary'}
              onClick={handleSwitch}
            >
              {t('newapi.noChannel.switchAndRetry')}
            </Button>
          </Flexbox>
        </Flexbox>
      }
      message={t('newapi.noChannel.title', {
        group: currentGroup || data.account.group,
        model: model || currentModel || t('newapi.noChannel.thisModel'),
      })}
    />
  );
});

NoChannelError.displayName = 'NoChannelError';

export default NoChannelError;
