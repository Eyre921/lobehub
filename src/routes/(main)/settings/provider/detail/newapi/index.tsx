'use client';

import { Flexbox } from '@lobehub/ui';
import { NewAPIProviderCard } from 'model-bank/modelProviders';
import { useTranslation } from 'react-i18next';

import ProviderDetail from '../default';
import AccountPanel from './AccountPanel';

const Page = () => {
  const { t } = useTranslation('modelProvider');

  return (
    <Flexbox gap={24}>
      <AccountPanel />
      <ProviderDetail
        {...NewAPIProviderCard}
        settings={{
          ...NewAPIProviderCard.settings,
          proxyUrl: {
            desc: t('newapi.apiUrl.desc'),
            placeholder: 'https://any-newapi-provider.com/',
            title: t('newapi.apiUrl.title'),
          },
        }}
      />
    </Flexbox>
  );
};

export default Page;
