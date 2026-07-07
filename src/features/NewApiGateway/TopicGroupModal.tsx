'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button, createModal, Select, useModalContext } from '@lobehub/ui/base-ui';
import { t } from 'i18next';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useChatStore } from '@/store/chat';
import { topicSelectors } from '@/store/chat/selectors';

import { buildGroupSelectOptions } from './groupOptions';
import { useNewapiGatewayAccount } from './useAccount';

interface TopicGroupModalContentProps {
  topicId: string;
}

const TopicGroupModalContent = memo<TopicGroupModalContentProps>(({ topicId }) => {
  const { t: tModel } = useTranslation('modelProvider');
  const { t: tCommon } = useTranslation('common');
  const { close } = useModalContext();
  const { data, isLoading } = useNewapiGatewayAccount();
  const updateTopicMetadata = useChatStore((s) => s.updateTopicMetadata);
  const currentGroup = useChatStore(
    (s) => topicSelectors.getTopicById(topicId)(s)?.metadata?.group ?? '',
  );
  const [value, setValue] = useState(currentGroup);
  const [saving, setSaving] = useState(false);

  if (isLoading && !data) return <Text type={'secondary'}>{tCommon('loading')}</Text>;
  if (!data || !data.enabled || !data.bound)
    return <Text type={'secondary'}>{tModel('newapi.topicGroup.unavailable')}</Text>;

  const options = buildGroupSelectOptions(data.account.usableGroups, tModel, {
    group: data.account.group,
  });

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // An empty value clears the explicit pin; the server re-snapshots the
      // account default group on the conversation's next request.
      await updateTopicMetadata(topicId, { group: value || undefined });
      close();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Flexbox gap={16}>
      <Text type={'secondary'}>{tModel('newapi.topicGroup.desc')}</Text>
      <Select options={options} value={value} onChange={(next: string) => setValue(next)} />
      <Flexbox horizontal gap={8} justify={'flex-end'}>
        <Button disabled={saving} onClick={close}>
          {tCommon('cancel')}
        </Button>
        <Button loading={saving} type={'primary'} onClick={handleSave}>
          {tCommon('save')}
        </Button>
      </Flexbox>
    </Flexbox>
  );
});

TopicGroupModalContent.displayName = 'TopicGroupModalContent';

/**
 * Imperatively open the per-conversation billing-group switcher for a topic.
 * Invoked from the topic context menu; pins the chosen group onto the topic's
 * metadata so every request in that conversation bills/routes on it,
 * independent of the account's default group and of other conversations.
 */
export const openTopicGroupModal = (topicId: string) =>
  createModal({
    content: <TopicGroupModalContent topicId={topicId} />,
    footer: null,
    maskClosable: true,
    styles: { header: { borderBottom: 'none' } },
    title: t('newapi.topicGroup.title', { ns: 'modelProvider' }),
    width: 'min(90vw, 480px)',
  });
