import * as _ from 'lodash';
import Web3 from 'web3';
import { Address, SetProtocolUtils } from 'set-protocol-utils';
import { Median, MedianContract } from 'set-protocol-contracts';
import {
  HistoricalPriceFeed,
  HistoricalPriceFeedContract,
  LegacyMakerOracleAdapter,
  LegacyMakerOracleAdapterContract,
  LinearizedPriceDataSource,
  LinearizedPriceDataSourceContract,
  MovingAverageOracle,
  MovingAverageOracleContract,
  MovingAverageOracleV2,
  MovingAverageOracleV2Contract,
  OracleProxy,
  OracleProxyContract,
  TimeSeriesFeed,
  TimeSeriesFeedContract,
} from 'set-protocol-strategies';

import { ONE_DAY_IN_SECONDS, TX_DEFAULTS } from '@src/constants';
import { BigNumber } from '@src/util';

const contract = require('truffle-contract');


export const deployMedianizerAsync = async(
  web3: Web3,
): Promise<MedianContract> => {
  const truffleMedianContract = contract(Median);
  truffleMedianContract.setProvider(web3.currentProvider);
  truffleMedianContract.setNetwork(50);
  truffleMedianContract.defaults(TX_DEFAULTS);

  // Deploy Median
  const deployedMedianInstance = await truffleMedianContract.new();
  return await MedianContract.at(
    deployedMedianInstance.address,
    web3,
    TX_DEFAULTS,
  );
};

export const addPriceFeedOwnerToMedianizer = async(
    medianizer: MedianContract,
    priceFeedSigner: Address,
  ): Promise<string> => {
  return await medianizer.lift.sendTransactionAsync(
    priceFeedSigner,
  );
};

export const updateMedianizerPriceAsync = async(
    web3: Web3,
    medianizer: MedianContract,
    price: BigNumber,
    timestamp: BigNumber,
    from: Address = TX_DEFAULTS.from,
  ): Promise<string> => {
    const setUtils = new SetProtocolUtils(web3);
    const standardSignature = SetProtocolUtils.hashPriceFeedHex(price, timestamp);
    const ecSignature = await setUtils.signMessage(standardSignature, from);

    return await medianizer.poke.sendTransactionAsync(
      [price],
      [timestamp],
      [new BigNumber(ecSignature.v)],
      [ecSignature.r],
      [ecSignature.s],
    );
};

export const deployHistoricalPriceFeedAsync = async(
  web3: Web3,
  updateFrequency: BigNumber,
  medianizerAddress: Address,
  dataDescription: string = '200DailyETHPrice',
  seededValues: BigNumber[] = [],
  from: Address = TX_DEFAULTS.from,
): Promise<HistoricalPriceFeedContract> => {
  const truffleHistoricalPriceFeedContract = contract(HistoricalPriceFeed);
  truffleHistoricalPriceFeedContract.setProvider(web3.currentProvider);
  truffleHistoricalPriceFeedContract.setNetwork(50);
  truffleHistoricalPriceFeedContract.defaults(TX_DEFAULTS);

  // Deploy HistoricalPriceFeed
  const deployedMedianInstance = await truffleHistoricalPriceFeedContract.new(
    updateFrequency,
    medianizerAddress,
    dataDescription,
    seededValues
  );
  return await HistoricalPriceFeedContract.at(
    deployedMedianInstance.address,
    web3,
    TX_DEFAULTS,
  );
};

export const deployLegacyMakerOracleAdapterAsync = async(
  web3: Web3,
  medianizerInstance: Address
): Promise<LegacyMakerOracleAdapterContract> => {
  const truffleAdapterContract = contract(LegacyMakerOracleAdapter);
  truffleAdapterContract.setProvider(web3.currentProvider);
  truffleAdapterContract.setNetwork(50);
  truffleAdapterContract.defaults(TX_DEFAULTS);

  // Deploy LegacyMakerOracleAdapter
  const deployedAdapterContractInstance = await truffleAdapterContract.new(
    medianizerInstance
  );
  return await LegacyMakerOracleAdapterContract.at(
    deployedAdapterContractInstance.address,
    web3,
    TX_DEFAULTS,
  );
};

export const deployOracleProxyAsync = async(
  web3: Web3,
  oracleInstance: Address
): Promise<OracleProxyContract> => {
  const truffleOracleProxy = contract(OracleProxy);
  truffleOracleProxy.setProvider(web3.currentProvider);
  truffleOracleProxy.setNetwork(50);
  truffleOracleProxy.defaults(TX_DEFAULTS);

  // Deploy OracleProxy
  const deployedOracleProxyInstance = await truffleOracleProxy.new(
    oracleInstance
  );
  return await OracleProxyContract.at(
    deployedOracleProxyInstance.address,
    web3,
    TX_DEFAULTS,
  );
};

export const deployTimeSeriesFeedAsync = async(
  web3: Web3,
  dataSourceAddress: Address,
  seededValues: BigNumber[] = [new BigNumber(200 * 10 ** 18)],
  updateFrequency: BigNumber = ONE_DAY_IN_SECONDS,
  maxDataPoints: BigNumber = new BigNumber(200),
  dataDescription: string = '200DailyETHPrice',
  from: Address = TX_DEFAULTS.from,
): Promise<TimeSeriesFeedContract> => {
  const truffleTimeSeriesFeedContract = contract(TimeSeriesFeed);
  truffleTimeSeriesFeedContract.setProvider(web3.currentProvider);
  truffleTimeSeriesFeedContract.setNetwork(50);
  truffleTimeSeriesFeedContract.defaults(TX_DEFAULTS);

  // Deploy TimeSeriesFeed
  const deployedTimeSeriesFeedInstance = await truffleTimeSeriesFeedContract.new(
    updateFrequency,
    maxDataPoints,
    dataSourceAddress,
    dataDescription,
    seededValues
  );
  return await TimeSeriesFeedContract.at(
    deployedTimeSeriesFeedInstance.address,
    web3,
    TX_DEFAULTS,
  );
};

export const deployLinearizedPriceDataSourceAsync = async(
  web3: Web3,
  medianizerAddress: Address,
  interpolationThreshold: BigNumber = ONE_DAY_IN_SECONDS.div(8),
  dataDescription: string = '200DailyETHPrice',
  from: Address = TX_DEFAULTS.from,
): Promise<LinearizedPriceDataSourceContract> => {
  const truffleLinearizedPriceDataSourceContract = contract(LinearizedPriceDataSource);
  truffleLinearizedPriceDataSourceContract.setProvider(web3.currentProvider);
  truffleLinearizedPriceDataSourceContract.setNetwork(50);
  truffleLinearizedPriceDataSourceContract.defaults(TX_DEFAULTS);

  // Deploy LinearizedPriceDataSource
  const deployedDataSourceInstance = await truffleLinearizedPriceDataSourceContract.new(
    interpolationThreshold,
    medianizerAddress,
    dataDescription
  );
  return await LinearizedPriceDataSourceContract.at(
    deployedDataSourceInstance.address,
    web3,
    TX_DEFAULTS,
  );
};

export const deployMovingAverageOracleAsync = async(
  web3: Web3,
  priceFeedAddress: Address,
  dataDescription: string,
  from: Address = TX_DEFAULTS.from,
): Promise<MovingAverageOracleContract> => {
  const truffleMovingAveragesOracleContract = contract(MovingAverageOracle);
  truffleMovingAveragesOracleContract.setProvider(web3.currentProvider);
  truffleMovingAveragesOracleContract.setNetwork(50);
  truffleMovingAveragesOracleContract.defaults(TX_DEFAULTS);

  // Deploy HistoricalPriceFeed
  const deployedMovingAverageOracleInstance = await truffleMovingAveragesOracleContract.new(
    priceFeedAddress,
    dataDescription
  );
  return await MovingAverageOracleContract.at(
    deployedMovingAverageOracleInstance.address,
    web3,
    TX_DEFAULTS,
  );
};

export const deployMovingAverageOracleV2Async = async(
  web3: Web3,
  priceFeedAddress: Address,
  dataDescription: string,
  from: Address = TX_DEFAULTS.from,
): Promise<MovingAverageOracleV2Contract> => {
  const truffleMovingAveragesOracleContract = contract(MovingAverageOracleV2);
  truffleMovingAveragesOracleContract.setProvider(web3.currentProvider);
  truffleMovingAveragesOracleContract.setNetwork(50);
  truffleMovingAveragesOracleContract.defaults(TX_DEFAULTS);

  // Deploy HistoricalPriceFeed
  const deployedMovingAverageOracleV2Instance = await truffleMovingAveragesOracleContract.new(
    priceFeedAddress,
    dataDescription
  );
  return await MovingAverageOracleV2Contract.at(
    deployedMovingAverageOracleV2Instance.address,
    web3,
    TX_DEFAULTS,
  );
};

export const approveContractToOracleProxy = async(
  oracleProxy: OracleProxyContract,
  authorizedAddress: Address,
): Promise<void> => {
  await oracleProxy.addAuthorizedAddress.sendTransactionAsync(authorizedAddress);
};
