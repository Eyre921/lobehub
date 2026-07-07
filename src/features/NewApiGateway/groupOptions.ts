import type { TFunction } from 'i18next';

interface UsableGroup {
  desc?: string;
  ratio: number | 'auto';
  sort: number;
}

export interface GroupSelectOption {
  label: string;
  value: string;
}

/**
 * Format the gateway account's usable billing groups into `<Select>` options,
 * each rendered as "name · ×ratio · desc". When `followDefault` is passed the
 * list is prefixed with a "follow account default" entry (empty value) that
 * clears an explicit per-conversation pin. Shared by the account panel, the
 * topic switcher modal, and the no-channel error card so the labels stay
 * identical across all three surfaces. `t` must be bound to the `modelProvider`
 * namespace (the caller's `useTranslation('modelProvider')`).
 */
export const buildGroupSelectOptions = (
  usableGroups: Record<string, UsableGroup>,
  t: TFunction<'modelProvider'>,
  followDefault?: { group: string },
): GroupSelectOption[] => {
  const groups = Object.entries(usableGroups)
    .sort(([, a], [, b]) => a.sort - b.sort)
    .map(([name, info]) => ({
      label: `${name} · ${
        info.ratio === 'auto' ? t('newapi.account.autoRatio') : `×${info.ratio}`
      }${info.desc && info.desc !== name ? ` · ${info.desc}` : ''}`,
      value: name,
    }));

  if (!followDefault) return groups;

  return [
    { label: t('newapi.account.followAccountGroup', { group: followDefault.group }), value: '' },
    ...groups,
  ];
};
