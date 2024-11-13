import type { ApiCheckTransactionDraftResult, ApiSubmitMultiTransferResult } from '../../../api/chains/ton/types';
import type { ApiSubmitTransferOptions, ApiSubmitTransferResult } from '../../../api/methods/types';
import type {
  ApiActivity,
  ApiDappTransfer,
  ApiSwapAsset,
  ApiToken,
  ApiTokenWithPrice,
  ApiTransactionError,
} from '../../../api/types';
import type { UserSwapToken, UserToken } from '../../types';
import { ApiTransactionDraftError } from '../../../api/types';
import { ActiveTab, TransferState } from '../../types';

import { IS_CAPACITOR, NFT_BATCH_SIZE } from '../../../config';
import { vibrateOnError, vibrateOnSuccess } from '../../../util/capacitor';
import { compareActivities } from '../../../util/compareActivities';
import { fromDecimal, toDecimal } from '../../../util/decimals';
import {
  buildCollectionByKey, extractKey, findLast, pick, unique,
} from '../../../util/iteratees';
import { callActionInMain, callActionInNative } from '../../../util/multitab';
import { onTickEnd, pause } from '../../../util/schedulers';
import { IS_DELEGATED_BOTTOM_SHEET, IS_DELEGATING_BOTTOM_SHEET } from '../../../util/windowEnvironment';
import { callApi } from '../../../api';
import { ApiHardwareBlindSigningNotEnabled, ApiUserRejectsError } from '../../../api/errors';
import { getIsSwapId, getIsTinyOrScamTransaction, getIsTxIdLocal } from '../../helpers';
import { addActionHandler, getGlobal, setGlobal } from '../../index';
import {
  clearCurrentTransfer,
  clearIsPinAccepted,
  setIsPinAccepted,
  updateAccountState,
  updateActivitiesIsHistoryEndReached,
  updateActivitiesIsLoading,
  updateBalances,
  updateCurrentAccountSettings,
  updateCurrentAccountState,
  updateCurrentSignature,
  updateCurrentTransfer,
  updateCurrentTransferByCheckResult,
  updateSendingLoading,
  updateSettings,
} from '../../reducers';
import { updateTokenInfo } from '../../reducers/tokens';
import {
  selectAccount,
  selectAccountState,
  selectAccountTxTokenSlugs,
  selectCurrentAccountSettings,
  selectCurrentAccountState,
  selectLastMainTxTimestamp,
  selectToken,
  selectTokenAddress,
} from '../../selectors';

const IMPORT_TOKEN_PAUSE = 250;

addActionHandler('startTransfer', (global, actions, payload) => {
  const isOpen = global.currentTransfer.state !== TransferState.None;
  if (IS_DELEGATED_BOTTOM_SHEET && !isOpen) {
    callActionInMain('startTransfer', payload);
    return;
  }

  const { isPortrait, ...rest } = payload ?? {};

  setGlobal(updateCurrentTransfer(global, {
    state: isPortrait ? TransferState.Initial : TransferState.None,
    error: undefined,
    ...rest,
  }));

  if (!isPortrait) {
    actions.setLandscapeActionsActiveTabIndex({ index: ActiveTab.Transfer });
  }
});

addActionHandler('changeTransferToken', (global, actions, { tokenSlug }) => {
  const { amount, tokenSlug: currentTokenSlug } = global.currentTransfer;
  const currentToken = currentTokenSlug ? global.tokenInfo.bySlug[currentTokenSlug] : undefined;
  const newToken = global.tokenInfo.bySlug[tokenSlug];

  if (amount && currentToken?.decimals !== newToken?.decimals) {
    global = updateCurrentTransfer(global, {
      amount: fromDecimal(toDecimal(amount, currentToken?.decimals), newToken?.decimals),
    });
  }

  setGlobal(updateCurrentTransfer(global, {
    tokenSlug,
    dieselStatus: undefined,
    dieselAmount: undefined,
    fee: undefined,
  }));
});

addActionHandler('setTransferScreen', (global, actions, payload) => {
  const { state } = payload;

  setGlobal(updateCurrentTransfer(global, { state }));
});

addActionHandler('setTransferAmount', (global, actions, { amount }) => {
  setGlobal(
    updateCurrentTransfer(global, {
      amount,
    }),
  );
});

addActionHandler('setTransferToAddress', (global, actions, { toAddress }) => {
  setGlobal(
    updateCurrentTransfer(global, {
      toAddress,
    }),
  );
});

addActionHandler('setTransferComment', (global, actions, { comment }) => {
  setGlobal(
    updateCurrentTransfer(global, {
      comment,
    }),
  );
});

addActionHandler('setTransferShouldEncrypt', (global, actions, { shouldEncrypt }) => {
  setGlobal(
    updateCurrentTransfer(global, {
      shouldEncrypt,
    }),
  );
});

addActionHandler('submitTransferInitial', async (global, actions, payload) => {
  if (IS_DELEGATING_BOTTOM_SHEET) {
    callActionInNative('submitTransferInitial', payload);
    return;
  }

  const {
    tokenSlug,
    toAddress,
    amount,
    comment,
    shouldEncrypt,
    nftAddresses,
    withDiesel,
    stateInit,
    isGaslessWithStars,
    binPayload,
  } = payload;

  setGlobal(updateSendingLoading(global, true));

  const { tokenAddress, chain } = selectToken(global, tokenSlug);
  let result: ApiCheckTransactionDraftResult | undefined;

  if (nftAddresses?.length) {
    result = await callApi('checkNftTransferDraft', {
      accountId: global.currentAccountId!,
      nftAddresses,
      toAddress,
      comment,
    });
  } else {
    result = await callApi('checkTransactionDraft', chain, {
      accountId: global.currentAccountId!,
      tokenAddress,
      toAddress,
      amount,
      data: binPayload ?? comment,
      shouldEncrypt,
      stateInit,
      isBase64Data: Boolean(binPayload),
      isGaslessWithStars,
    });
  }

  global = getGlobal();
  global = updateSendingLoading(global, false);

  if (!result || 'error' in result) {
    if (result) {
      global = updateCurrentTransferByCheckResult(global, result);
    }

    if (result?.fee) {
      global = updateCurrentTransfer(global, { fee: result.fee });
    }

    setGlobal(global);

    if (result?.error === ApiTransactionDraftError.InsufficientBalance && !nftAddresses?.length) {
      actions.showDialog({ message: 'The network fee has slightly changed, try sending again.' });
    } else {
      actions.showError({ error: result?.error });
    }

    return;
  }

  global = updateCurrentTransfer(global, { fee: result.fee });

  setGlobal(updateCurrentTransfer(global, {
    state: TransferState.Confirm,
    error: undefined,
    toAddress,
    chain,
    resolvedAddress: result.resolvedAddress,
    amount,
    comment,
    shouldEncrypt,
    toAddressName: result.addressName,
    tokenSlug,
    isToNewAddress: result.isToAddressNew,
    isScam: result.isScam,
    isMemoRequired: result.isMemoRequired,
    withDiesel,
    isGaslessWithStars,
  }));
});

addActionHandler('fetchFee', async (global, actions, payload) => {
  global = updateCurrentTransfer(global, { isLoading: true, error: undefined });
  setGlobal(global);

  const {
    tokenSlug, toAddress, amount, comment, shouldEncrypt, binPayload, stateInit, isGaslessWithStars,
  } = payload;

  const { tokenAddress, chain } = selectToken(global, tokenSlug);

  const result = await callApi('checkTransactionDraft', chain, {
    accountId: global.currentAccountId!,
    toAddress,
    amount,
    data: binPayload ?? comment,
    tokenAddress,
    shouldEncrypt,
    isBase64Data: Boolean(binPayload),
    stateInit,
    isGaslessWithStars,
  });

  global = getGlobal();
  global = updateCurrentTransfer(global, { isLoading: false });

  if (result) {
    global = updateCurrentTransferByCheckResult(global, result);

    if (result.fee !== undefined) {
      global = updateCurrentTransfer(global, { fee: result.fee });
    }
  }

  setGlobal(global);

  if (result?.error && result.error !== ApiTransactionDraftError.InsufficientBalance) {
    actions.showError({ error: result.error });
  }
});

addActionHandler('fetchNftFee', async (global, actions, payload) => {
  const { toAddress, nftAddresses, comment } = payload;

  global = updateCurrentTransfer(global, { isLoading: true, error: undefined });
  setGlobal(global);

  const result = await callApi('checkNftTransferDraft', {
    accountId: global.currentAccountId!,
    nftAddresses,
    toAddress,
    comment,
  });

  global = getGlobal();
  global = updateCurrentTransfer(global, { isLoading: false });

  if (result?.fee) {
    global = updateCurrentTransfer(global, { fee: result.fee });
  }

  setGlobal(global);

  if (result?.error) {
    actions.showError({
      error: result?.error === ApiTransactionDraftError.InsufficientBalance
        ? 'Insufficient TON for fee.'
        : result.error,
    });
  }
});

addActionHandler('submitTransferConfirm', (global, actions) => {
  const accountId = global.currentAccountId!;
  const account = selectAccount(global, accountId)!;

  if (account.isHardware) {
    actions.resetHardwareWalletConnect();
    global = updateCurrentTransfer(getGlobal(), { state: TransferState.ConnectHardware });
  } else {
    global = updateCurrentTransfer(global, { state: TransferState.Password });
  }

  setGlobal(global);
});

addActionHandler('submitTransferPassword', async (global, actions, { password }) => {
  const {
    resolvedAddress,
    comment,
    amount,
    promiseId,
    tokenSlug,
    fee,
    shouldEncrypt,
    binPayload,
    nfts,
    withDiesel,
    dieselAmount,
    stateInit,
    isGaslessWithStars,
  } = global.currentTransfer;

  if (!(await callApi('verifyPassword', password))) {
    setGlobal(updateCurrentTransfer(getGlobal(), { error: 'Wrong password, please try again.' }));

    return;
  }

  global = getGlobal();
  global = updateCurrentTransfer(getGlobal(), {
    isLoading: true,
    error: undefined,
  });
  if (IS_CAPACITOR) {
    global = setIsPinAccepted(global);
  }
  setGlobal(global);

  if (IS_CAPACITOR) {
    await vibrateOnSuccess(true);
  }

  if (promiseId) {
    if (IS_CAPACITOR) {
      global = getGlobal();
      global = setIsPinAccepted(global);
      setGlobal(global);
    }

    void callApi('confirmDappRequest', promiseId, password);
    return;
  }

  let result: ApiSubmitTransferResult | ApiSubmitMultiTransferResult | undefined;

  if (nfts?.length) {
    const chunks = [];
    for (let i = 0; i < nfts.length; i += NFT_BATCH_SIZE) {
      chunks.push(nfts.slice(i, i + NFT_BATCH_SIZE));
    }

    for (const chunk of chunks) {
      const addresses = chunk.map(({ address }) => address);
      const batchResult = await callApi(
        'submitNftTransfers',
        global.currentAccountId!,
        password,
        addresses,
        resolvedAddress!,
        comment,
        chunk,
        fee,
      );

      global = getGlobal();
      global = updateCurrentTransfer(global, {
        sentNftsCount: (global.currentTransfer.sentNftsCount || 0) + chunk.length,
      });
      setGlobal(global);
      // TODO - process all responses from the API
      result = batchResult;
    }
  } else {
    const { tokenAddress, chain } = selectToken(global, tokenSlug!);

    const options: ApiSubmitTransferOptions = {
      accountId: global.currentAccountId!,
      password,
      toAddress: resolvedAddress!,
      amount: amount!,
      comment: binPayload ?? comment,
      tokenAddress,
      fee,
      shouldEncrypt,
      isBase64Data: Boolean(binPayload),
      withDiesel,
      dieselAmount,
      stateInit,
      isGaslessWithStars,
    };

    result = await callApi('submitTransfer', chain, options);
  }

  global = getGlobal();
  global = updateCurrentTransfer(global, {
    isLoading: false,
  });
  setGlobal(global);

  if (!result || 'error' in result) {
    if (IS_CAPACITOR) {
      global = getGlobal();
      global = clearIsPinAccepted(global);
      setGlobal(global);
      void vibrateOnError();
    }
    actions.showError({ error: result?.error });
  } else if (IS_CAPACITOR) {
    void vibrateOnSuccess();
  }
});

addActionHandler('submitTransferHardware', async (global, actions) => {
  const {
    toAddress,
    resolvedAddress,
    comment,
    amount,
    promiseId,
    tokenSlug,
    fee,
    rawPayload,
    parsedPayload,
    stateInit,
    nfts,
  } = global.currentTransfer;

  const accountId = global.currentAccountId!;

  setGlobal(updateCurrentTransfer(getGlobal(), {
    isLoading: true,
    error: undefined,
    state: TransferState.ConfirmHardware,
  }));

  const ledgerApi = await import('../../../util/ledger');

  if (promiseId) {
    const message: ApiDappTransfer = {
      toAddress: toAddress!,
      amount: amount!,
      rawPayload,
      payload: parsedPayload,
      stateInit,
    };

    try {
      const signedMessage = await ledgerApi.signLedgerTransactions(accountId, [message]);
      void callApi('confirmDappRequest', promiseId, signedMessage);
    } catch (err) {
      if (err instanceof ApiUserRejectsError) {
        setGlobal(updateCurrentTransfer(getGlobal(), {
          isLoading: false,
          error: 'Canceled by the user',
        }));
      } else {
        void callApi('cancelDappRequest', promiseId, 'Unknown error.');
      }
    }
    return;
  }

  let result: string | { error: ApiTransactionError } | undefined;
  let error: string | undefined;

  if (nfts?.length) {
    for (const nft of nfts) {
      const currentResult = await ledgerApi.submitLedgerNftTransfer({
        accountId: global.currentAccountId!,
        nftAddress: nft.address,
        password: '',
        toAddress: resolvedAddress!,
        comment,
        nft,
        fee,
      });

      global = getGlobal();
      global = updateCurrentTransfer(global, {
        sentNftsCount: (global.currentTransfer.sentNftsCount || 0) + 1,
      });
      setGlobal(global);
      result = currentResult;
    }
  } else {
    const tokenAddress = selectTokenAddress(global, tokenSlug!);
    const options = {
      accountId: global.currentAccountId!,
      password: '',
      toAddress: resolvedAddress!,
      amount: amount!,
      comment,
      tokenAddress,
      fee,
    };

    try {
      result = await ledgerApi.submitLedgerTransfer(options, tokenSlug!);
    } catch (err: any) {
      if (err instanceof ApiHardwareBlindSigningNotEnabled) {
        error = '$hardware_blind_sign_not_enabled';
      }
    }
  }

  if (!error && result === undefined) {
    error = 'Declined';
  } else if (typeof result === 'object' && 'error' in result) {
    actions.showError({
      error: result.error,
    });
  }

  setGlobal(updateCurrentTransfer(getGlobal(), {
    isLoading: false,
    error,
  }));
});

addActionHandler('clearTransferError', (global) => {
  setGlobal(updateCurrentTransfer(global, { error: undefined }));
});

addActionHandler('cancelTransfer', (global, actions, { shouldReset } = {}) => {
  const { promiseId, tokenSlug } = global.currentTransfer;

  if (shouldReset) {
    if (promiseId) {
      void callApi('cancelDappRequest', promiseId, 'Canceled by the user');
    }

    global = clearCurrentTransfer(global);
    global = updateCurrentTransfer(global, { tokenSlug });

    setGlobal(global);
    return;
  }

  if (IS_CAPACITOR) {
    global = clearIsPinAccepted(global);
  }
  global = updateCurrentTransfer(global, { state: TransferState.None });
  setGlobal(global);
});

addActionHandler('fetchTokenTransactions', async (global, actions, { limit, slug, shouldLoadWithBudget }) => {
  global = updateActivitiesIsLoading(global, true);
  setGlobal(global);

  const accountId = global.currentAccountId!;

  let { idsBySlug, byId } = selectAccountState(global, accountId)?.activities || {};
  let shouldFetchMore = true;
  let fetchedActivities: ApiActivity[] = [];
  let tokenIds = (idsBySlug && idsBySlug[slug]) || [];
  const toTxId = findLast(tokenIds, (id) => !getIsTxIdLocal(id) && !getIsSwapId(id));
  let toTimestamp = toTxId && byId ? byId[toTxId].timestamp : undefined;
  const { chain } = selectToken(global, slug);

  while (shouldFetchMore) {
    const result = await callApi('fetchTokenActivitySlice', accountId, chain, slug, toTimestamp, limit);

    global = getGlobal();

    if (!result || 'error' in result) {
      break;
    }

    if (!result.length) {
      global = updateActivitiesIsHistoryEndReached(global, true, slug);
      break;
    }

    const filteredResult = global.settings.areTinyTransfersHidden
      ? result.filter((tx) => tx.kind === 'transaction' && !getIsTinyOrScamTransaction(tx))
      : result;

    fetchedActivities = fetchedActivities.concat(result);
    shouldFetchMore = filteredResult.length < limit && fetchedActivities.length < limit;

    tokenIds = unique(tokenIds.concat(filteredResult.map((tx) => tx.id)));
    toTimestamp = result[result.length - 1].timestamp;
  }

  fetchedActivities.sort(compareActivities);

  global = updateActivitiesIsLoading(global, false);

  const newById = buildCollectionByKey(fetchedActivities, 'id');
  const newOrderedIds = Object.keys(newById);
  const currentActivities = selectAccountState(global, accountId)?.activities;
  byId = { ...(currentActivities?.byId || {}), ...newById };

  idsBySlug = currentActivities?.idsBySlug || {};
  tokenIds = unique((idsBySlug[slug] || []).concat(newOrderedIds));

  tokenIds.sort((a, b) => compareActivities(byId[a], byId[b]));

  global = updateAccountState(global, accountId, {
    activities: {
      ...currentActivities,
      byId,
      idsBySlug: { ...idsBySlug, [slug]: tokenIds },
    },
  });

  setGlobal(global);

  if (shouldLoadWithBudget) {
    onTickEnd(() => {
      actions.fetchTokenTransactions({ limit, slug });
    });
  }
});

addActionHandler('fetchAllTransactions', async (global, actions, { limit, shouldLoadWithBudget }) => {
  global = updateActivitiesIsLoading(global, true);
  setGlobal(global);

  const accountId = global.currentAccountId!;

  const tonTokenSlugs = selectAccountTxTokenSlugs(global, accountId, 'ton') ?? [];
  const tronTokenSlugs = selectAccountTxTokenSlugs(global, accountId, 'tron') ?? [];
  let toTimestamp = selectLastMainTxTimestamp(global, accountId)!;
  let shouldFetchMore = true;
  let fetchedActivities: ApiActivity[] = [];

  while (shouldFetchMore) {
    const result = await callApi(
      'fetchAllActivitySlice',
      accountId,
      limit,
      toTimestamp,
      tonTokenSlugs,
      tronTokenSlugs,
    );

    global = getGlobal();

    if (!result || 'error' in result) {
      break;
    }

    if (!result.length) {
      global = updateActivitiesIsHistoryEndReached(global, true);
      break;
    }

    const filteredResult = global.settings.areTinyTransfersHidden
      ? result.filter((tx) => tx.kind === 'transaction' && !getIsTinyOrScamTransaction(tx))
      : result;

    fetchedActivities = fetchedActivities.concat(result);
    shouldFetchMore = filteredResult.length < limit && fetchedActivities.length < limit;
    toTimestamp = result[result.length - 1].timestamp;
  }

  global = updateActivitiesIsLoading(global, false);

  const newById = buildCollectionByKey(fetchedActivities, 'id');
  const currentActivities = selectAccountState(global, accountId)?.activities;
  const byId = { ...(currentActivities?.byId || {}), ...newById };

  fetchedActivities.sort(compareActivities);

  const idsMain = unique((currentActivities?.idsMain ?? []).concat(extractKey(fetchedActivities, 'id')));

  global = updateAccountState(global, accountId, {
    activities: {
      ...currentActivities,
      byId,
      idsMain,
    },
  });

  setGlobal(global);

  if (shouldLoadWithBudget) {
    onTickEnd(() => {
      actions.fetchAllTransactions({ limit });
    });
  }
});

addActionHandler('resetIsHistoryEndReached', (global, actions, payload) => {
  global = updateActivitiesIsHistoryEndReached(global, false, payload?.slug);
  setGlobal(global);
});

addActionHandler('setIsBackupRequired', (global, actions, { isMnemonicChecked }) => {
  const { isBackupRequired } = selectCurrentAccountState(global) ?? {};

  setGlobal(updateCurrentAccountState(global, {
    isBackupRequired: isMnemonicChecked ? undefined : isBackupRequired,
  }));
});

addActionHandler('submitSignature', async (global, actions, payload) => {
  const { password } = payload;
  const { promiseId } = global.currentSignature!;

  if (!(await callApi('verifyPassword', password))) {
    setGlobal(updateCurrentSignature(getGlobal(), { error: 'Wrong password, please try again.' }));

    return;
  }

  await callApi('confirmDappRequest', promiseId, password!);

  setGlobal(updateCurrentSignature(getGlobal(), { isSigned: true }));
});

addActionHandler('clearSignatureError', (global) => {
  setGlobal(updateCurrentSignature(global, { error: undefined }));
});

addActionHandler('cancelSignature', (global) => {
  const { promiseId } = global.currentSignature || {};

  if (promiseId) {
    void callApi('cancelDappRequest', promiseId, 'Canceled by the user');
  }

  setGlobal({
    ...global,
    currentSignature: undefined,
  });
});

addActionHandler('addToken', (global, actions, { token }) => {
  if (!global.tokenInfo?.bySlug?.[token.slug]) {
    global = updateTokenInfo(global, {
      [token.slug]: {
        name: token.name,
        symbol: token.symbol,
        slug: token.slug,
        decimals: token.decimals,
        chain: token.chain,
        image: token.image,
        keywords: token.keywords,
        quote: {
          slug: token.slug,
          price: token.price ?? 0,
          priceUsd: token.priceUsd ?? 0,
          percentChange24h: token.change24h ?? 0,
        },
      },
    });
  }

  const { balances } = selectCurrentAccountState(global) ?? {};
  if (!balances?.bySlug[token.slug]) {
    global = updateCurrentAccountState(global, {
      balances: {
        ...balances,
        bySlug: {
          ...balances?.bySlug,
          [token.slug]: 0n,
        },
      },
    });
  }

  const accountSettings = selectCurrentAccountSettings(global) ?? {};
  global = updateCurrentAccountSettings(global, {
    ...accountSettings,
    orderedSlugs: [...accountSettings.orderedSlugs ?? [], token.slug],
    exceptionSlugs: unique([...accountSettings.exceptionSlugs ?? [], token.slug]),
    deletedSlugs: accountSettings.deletedSlugs?.filter((slug) => slug !== token.slug),
  });

  return global;
});

addActionHandler('importToken', async (global, actions, { address }) => {
  const { currentAccountId } = global;
  global = updateSettings(global, {
    importToken: {
      isLoading: true,
      token: undefined,
    },
  });
  setGlobal(global);

  const slug = (await callApi('buildTokenSlug', 'ton', address))!;
  global = getGlobal();

  let token: ApiTokenWithPrice | ApiToken | undefined = global.tokenInfo.bySlug?.[slug!];

  if (!token) {
    token = await callApi('fetchToken', global.currentAccountId!, address);
    await pause(IMPORT_TOKEN_PAUSE);

    global = getGlobal();
    if (!token) {
      global = updateSettings(global, {
        importToken: {
          isLoading: false,
          token: undefined,
        },
      });
      setGlobal(global);
      return;
    } else {
      const apiToken: ApiTokenWithPrice = {
        ...token,
        quote: {
          slug: token.slug,
          price: 0,
          priceUsd: 0,
          percentChange24h: 0,
        },
      };
      global = updateTokenInfo(global, { [apiToken.slug]: apiToken });
      setGlobal(global);
    }
  }

  const balances = selectAccountState(global, currentAccountId!)?.balances?.bySlug ?? {};
  const shouldUpdateBalance = !(token.slug in balances);

  const userToken: UserToken | UserSwapToken = {
    ...pick(token, [
      'symbol',
      'slug',
      'name',
      'image',
      'decimals',
      'keywords',
      'chain',
      'tokenAddress',
    ]),
    amount: 0n,
    totalValue: '0',
    price: 0,
    priceUsd: 0,
    change24h: 0,
  };

  global = getGlobal();
  global = updateSettings(global, {
    importToken: {
      isLoading: false,
      token: userToken,
    },
  });
  if (shouldUpdateBalance) {
    global = updateBalances(global, global.currentAccountId!, { [token.slug]: 0n });
  }
  setGlobal(global);
});

addActionHandler('resetImportToken', (global) => {
  global = updateSettings(global, {
    importToken: {
      isLoading: false,
      token: undefined,
    },
  });
  setGlobal(global);
});

addActionHandler('verifyHardwareAddress', async (global, actions) => {
  const accountId = global.currentAccountId!;

  const ledgerApi = await import('../../../util/ledger');

  if (!(await ledgerApi.reconnectLedger())) {
    actions.showError({ error: '$ledger_not_ready' });
    return;
  }

  try {
    actions.showDialog({ title: 'Ledger', message: '$ledger_verify_address_on_device' });
    await ledgerApi.verifyAddress(accountId);
  } catch (err) {
    actions.showError({ error: err as string });
  }
});

addActionHandler('setActiveContentTab', (global, actions, { tab }) => {
  return updateCurrentAccountState(global, {
    activeContentTab: tab,
  });
});

addActionHandler('addSwapToken', (global, actions, { token }) => {
  const isAlreadyExist = token.slug in global.swapTokenInfo.bySlug;

  if (isAlreadyExist) {
    return;
  }

  const apiSwapAsset: ApiSwapAsset = {
    name: token.name,
    symbol: token.symbol,
    chain: token.chain,
    slug: token.slug,
    decimals: token.decimals,
    image: token.image,
    tokenAddress: token.tokenAddress,
    keywords: token.keywords,
    isPopular: false,
    price: 0,
    priceUsd: 0,
  };

  setGlobal({
    ...global,
    swapTokenInfo: {
      ...global.swapTokenInfo,
      bySlug: {
        ...global.swapTokenInfo.bySlug,
        [apiSwapAsset.slug]: apiSwapAsset,
      },
    },
  });
});

addActionHandler('fetchDieselState', async (global, actions, { tokenSlug }) => {
  const tokenAddress = selectTokenAddress(global, tokenSlug);
  if (!tokenAddress) return;

  const result = await callApi('fetchDieselState', global.currentAccountId!, tokenAddress);
  if (!result || !result.status) return;

  global = getGlobal();
  const accountState = selectAccountState(global, global.currentAccountId!);
  global = updateCurrentTransfer(global, {
    dieselStatus: result.status,
    dieselAmount: result.amount,
  });
  if (accountState?.isDieselAuthorizationStarted && result.status !== 'not-authorized') {
    global = updateAccountState(global, global.currentAccountId!, { isDieselAuthorizationStarted: undefined });
  }
  setGlobal(global);
});

addActionHandler('apiUpdateWalletVersions', (global, actions, params) => {
  const { accountId, versions, currentVersion } = params;
  global = {
    ...global,
    walletVersions: {
      ...global.walletVersions,
      currentVersion,
      byId: {
        ...global.walletVersions?.byId,
        [accountId]: versions,
      },
    },
  };
  setGlobal(global);
});