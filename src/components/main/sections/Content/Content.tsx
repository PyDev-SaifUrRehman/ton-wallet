import React, {
  memo, useEffect, useMemo, useRef,
} from '../../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../../global';

import type { ApiNft } from '../../../../api/types';
import type { DropdownItem } from '../../../ui/Dropdown';
import { ContentTab, SettingsState } from '../../../../global/types';

import {
  LANDSCAPE_MIN_ASSETS_TAB_VIEW,
  NOTCOIN_VOUCHERS_ADDRESS,
  PORTRAIT_MIN_ASSETS_TAB_VIEW,
} from '../../../../config';
import {
  selectCurrentAccountState,
  selectCurrentAccountTokens,
  selectEnabledTokensCountMemoizedFor,
} from '../../../../global/selectors';
import buildClassName from '../../../../util/buildClassName';
import { captureEvents, SwipeDirection } from '../../../../util/captureEvents';
import { IS_TOUCH_ENV } from '../../../../util/windowEnvironment';

import { useDeviceScreen } from '../../../../hooks/useDeviceScreen';
import useEffectOnce from '../../../../hooks/useEffectOnce';
import useHistoryBack from '../../../../hooks/useHistoryBack';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';
import useSyncEffect from '../../../../hooks/useSyncEffect';

import TabList from '../../../ui/TabList';
import Transition from '../../../ui/Transition';
import HideNftModal from '../../modals/HideNftModal';
import Activity from './Activities';
import Assets from './Assets';
import Explore from './Explore';
import NftCollectionHeader from './NftCollectionHeader';
import Nfts from './Nfts';
import NftSelectionHeader from './NftSelectionHeader';

import styles from './Content.module.scss';
import P2p from './P2p';

interface OwnProps {
  onStakedTokenClick: NoneToVoidFunction;
}

interface StateProps {
  tokensCount: number;
  nfts?: Record<string, ApiNft>;
  currentCollectionAddress?: string;
  selectedAddresses?: string[];
  activeContentTab?: ContentTab;
  blacklistedNftAddresses?: string[];
  whitelistedNftAddresses?: string[];
  selectedNftsToHide?: {
    addresses: string[];
    isCollection: boolean;
  };
}

let activeNftKey = 0;

function Content({
  activeContentTab,
  tokensCount,
  nfts,
  currentCollectionAddress,
  selectedAddresses,
  onStakedTokenClick,
  blacklistedNftAddresses,
  whitelistedNftAddresses,
  selectedNftsToHide,
}: OwnProps & StateProps) {
  const {
    selectToken,
    setActiveContentTab,
    openNftCollection,
    closeNftCollection,
    openSettingsWithState,
  } = getActions();

  const lang = useLang();
  const { isPortrait } = useDeviceScreen();
  const hasNftSelection = Boolean(selectedAddresses?.length);

  useSyncEffect(() => {
    if (currentCollectionAddress) {
      activeNftKey += 1;
    } else {
      activeNftKey = 0;
    }
  }, [currentCollectionAddress]);

  const handleNftCollectionClick = useLastCallback((address: string) => {
    openNftCollection({ address }, { forceOnHeavyAnimation: true });
  });

  const handleNftsMenuButtonClick = useLastCallback((value: string) => {
    if (value === 'hidden_nfts') {
      openSettingsWithState({ state: SettingsState.HiddenNfts });
    } else {
      handleNftCollectionClick(value);
    }
  });

  const nftCollections = useMemo(() => {
    const blacklistedNftAddressesSet = new Set(blacklistedNftAddresses);
    const whitelistedNftAddressesSet = new Set(whitelistedNftAddresses);
    const collections = Object.values(nfts ?? {})
      .filter((nft) => (
        !nft.isHidden || whitelistedNftAddressesSet.has(nft.address)
      ) && !blacklistedNftAddressesSet.has(nft.address))
      .reduce((acc, nft) => {
        if (nft.collectionAddress) {
          acc[nft.collectionAddress] = nft.collectionName || lang('Unnamed collection');
        }

        return acc;
      }, {} as Record<string, string>);
    const collentionAddresses = Object.keys(collections);
    collentionAddresses.sort((left, right) => collections[left].localeCompare(collections[right]));

    return collentionAddresses.map<DropdownItem>((key) => {
      return {
        id: key,
        name: collections[key],
        value: key,
      };
    });
  }, [lang, nfts, blacklistedNftAddresses, whitelistedNftAddresses]);

  const shouldRenderHiddenNftsSection = useMemo(() => {
    const blacklistedAddressesSet = new Set(blacklistedNftAddresses);
    return Object.values(nfts ?? {}).some(
      (nft) => blacklistedAddressesSet.has(nft.address) || nft.isHidden,
    );
  }, [blacklistedNftAddresses, nfts]);

  // eslint-disable-next-line no-null/no-null
  const transitionRef = useRef<HTMLDivElement>(null);

  const shouldShowSeparateAssetsPanel = tokensCount > 0
    && tokensCount <= (isPortrait ? PORTRAIT_MIN_ASSETS_TAB_VIEW : LANDSCAPE_MIN_ASSETS_TAB_VIEW);
  const tabs = useMemo(
    () => [
      ...(
        !shouldShowSeparateAssetsPanel
          ? [{ id: ContentTab.Assets, title: lang('Assets'), className: styles.tab }]
          : []
      ),
      { id: ContentTab.Activity, title: lang('Activity'), className: styles.tab },
      { id: ContentTab.Referral, title: lang('Referral'), className: styles.tab },
      { id: ContentTab.P2p, title: lang('P2P'), className: styles.tab },

    
      {
        id: ContentTab.Nft,
        title: lang('NFT'),
        className: styles.tab,
        menuItems: shouldRenderHiddenNftsSection
          ? [
            ...nftCollections,
            {
              name: lang('Hidden NFTs'),
              value: 'hidden_nfts',
              withSeparator: true,
            } as DropdownItem,
          ]
          : nftCollections,
        onMenuItemClick: handleNftsMenuButtonClick,
      },
      ...(nftCollections.some(({ value }) => value === NOTCOIN_VOUCHERS_ADDRESS) ? [{
        id: ContentTab.NotcoinVouchers,
        title: 'NOT Vouchers',
        className: styles.tab,
      }] : []),
    ],
    [lang, nftCollections, shouldShowSeparateAssetsPanel, shouldRenderHiddenNftsSection],
  );

  const activeTabIndex = useMemo(
    () => {
      const tabIndex = tabs.findIndex((tab) => tab.id === activeContentTab);

      if (tabIndex === -1) {
        return ContentTab.Assets;
      }

      return tabIndex;
    },
    [tabs, activeContentTab],
  );

  useEffectOnce(() => {
    if (activeContentTab === undefined) {
      setActiveContentTab({ tab: ContentTab.Assets });
    }
  });

  const handleSwitchTab = useLastCallback((tab: ContentTab) => {
    if (tab === ContentTab.NotcoinVouchers) {
      selectToken({ slug: undefined }, { forceOnHeavyAnimation: true });
      setActiveContentTab({ tab: ContentTab.Nft });
      handleNftCollectionClick(NOTCOIN_VOUCHERS_ADDRESS);

      return;
    }

    selectToken({ slug: undefined }, { forceOnHeavyAnimation: true });
    setActiveContentTab({ tab });
  });

  useHistoryBack({
    isActive: activeTabIndex !== 0,
    onBack: () => handleSwitchTab(ContentTab.Assets),
  });

  useEffect(() => {
    if (!IS_TOUCH_ENV) {
      return undefined;
    }


 //case  ContentTab.P2p:
//  return <P2p isActive={isActive} />


    return captureEvents(transitionRef.current!, {
      includedClosestSelector: '.swipe-container',
      excludedClosestSelector: '.dapps-feed',
      onSwipe: (e, direction) => {
        if (direction === SwipeDirection.Left) {
          const tab = tabs[Math.min(tabs.length - 1, activeTabIndex + 1)];
          handleSwitchTab(tab.id);
          return true;
        } else if (direction === SwipeDirection.Right) {
          if (currentCollectionAddress) {
            closeNftCollection();
          } else {
            const tab = tabs[Math.max(0, activeTabIndex - 1)];
            handleSwitchTab(tab.id);
          }
          return true;
        }

        return false;
      },
      selectorToPreventScroll: '.custom-scroll',
    });
  }, [tabs, handleSwitchTab, activeTabIndex, currentCollectionAddress]);

  const handleClickAsset = useLastCallback((slug: string) => {
    selectToken({ slug }, { forceOnHeavyAnimation: true });
    setActiveContentTab({ tab: ContentTab.Activity });
  });

  const containerClassName = buildClassName(
    styles.container,
    IS_TOUCH_ENV && 'swipe-container',
    isPortrait ? styles.portraitContainer : styles.landscapeContainer,
  );

  function renderTabsPanel() {
    if (hasNftSelection) {
      return <NftSelectionHeader />;
    }

    return currentCollectionAddress ? <NftCollectionHeader key="collection" /> : (
      <TabList
        tabs={tabs}
        activeTab={activeTabIndex}
        onSwitchTab={handleSwitchTab}
        withBorder
        className={buildClassName(styles.tabs, 'content-tabslist')}
      />
    );
  }

  function renderCurrentTab(isActive: boolean) {
    // When assets are shown separately, there is effectively no tab with index 0,
    // so we fall back to next tab to not break parent's component logic.
    if (activeTabIndex === 0 && shouldShowSeparateAssetsPanel) {
      return <Activity isActive={isActive} />;
    }


    
    switch (tabs[activeTabIndex].id) {
      case ContentTab.Assets:
        return <Assets isActive={isActive} onTokenClick={handleClickAsset} onStakedTokenClick={onStakedTokenClick} />;
      case ContentTab.Activity:
        return <Activity isActive={isActive} />;
     
      case ContentTab.Nft:
       
    
        return (
          <Transition
            activeKey={activeNftKey}
            name={isPortrait ? 'slide' : 'slideFade'}
            className="nfts-container"
          >
            <Nfts key={currentCollectionAddress || 'all'} isActive={isActive} />
                    </Transition>
        );
        
    

      case ContentTab.Referral:
        return <Explore isActive={isActive} />;

    

          
        
      default:
        return undefined;
    }
  }


     




  function renderContent() {
    const activeKey = hasNftSelection ? 2 : (currentCollectionAddress ? 1 : 0);

    return (
      <>
        <Transition activeKey={activeKey} name="slideFade" className={styles.tabsContainer}>
          {renderTabsPanel()}
        </Transition>
        <Transition
          ref={transitionRef}
          name={isPortrait ? 'slide' : 'slideFade'}
          activeKey={activeTabIndex}
          renderCount={tabs.length}
          className={buildClassName(styles.slides, 'content-transition')}
          slideClassName={buildClassName(styles.slide, 'custom-scroll')}
        >
          {renderCurrentTab}
        </Transition>
      </>
    );
  }

  return (
    <div className={containerClassName}>
      {shouldShowSeparateAssetsPanel && (
        <div className={styles.assetsPanel}>
          <Assets
            isActive
            isSeparatePanel
            onStakedTokenClick={onStakedTokenClick}
            onTokenClick={handleClickAsset}
          />
        </div>
      )}
      <div className={buildClassName(isPortrait ? styles.contentPanel : styles.landscapeContentPanel)}>
        {renderContent()}
      </div>
      <HideNftModal
        isOpen={Boolean(selectedNftsToHide?.addresses.length)}
        selectedNftsToHide={selectedNftsToHide}
      />

    </div>
  );
}

export default memo(
  withGlobal<OwnProps>(
    (global): StateProps => {
      const {
        activeContentTab,
        blacklistedNftAddresses,
        whitelistedNftAddresses,
        selectedNftsToHide,
        nfts: {
          byAddress: nfts,
          currentCollectionAddress,
          selectedAddresses,
        } = {},
      } = selectCurrentAccountState(global) ?? {};
      const tokens = selectCurrentAccountTokens(global);
      const tokensCount = selectEnabledTokensCountMemoizedFor(global.currentAccountId!)(tokens);

      return {
        nfts,
        currentCollectionAddress,
        selectedAddresses,
        tokensCount,
        activeContentTab,
        blacklistedNftAddresses,
        whitelistedNftAddresses,
        selectedNftsToHide,
      };
    },
    (global, _, stickToFirst) => stickToFirst(global.currentAccountId),
  )(Content),
);
