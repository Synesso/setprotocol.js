/*
  Copyright 2018 Set Labs Inc.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

'use strict';

// Given that this is an integration test, we unmock the Set Protocol
// smart contracts artifacts package to pull the most recently
// deployed contracts on the current network.
jest.unmock('set-protocol-contracts');
jest.setTimeout(30000);

const timeKeeper = require('timekeeper');
const moment = require('moment');
import * as _ from 'lodash';
import * as ABIDecoder from 'abi-decoder';
import * as chai from 'chai';
import * as setProtocolUtils from 'set-protocol-utils';
import Web3 from 'web3';
import { Core } from 'set-protocol-contracts';
import {
  CoreContract,
  ConstantAuctionPriceCurveContract,
  MedianContract,
  SetTokenContract,
  RebalancingSetTokenContract,
  RebalancingSetTokenFactoryContract,
  SetTokenFactoryContract,
  StandardTokenMockContract,
  TransferProxyContract,
  WhiteListContract,
} from 'set-protocol-contracts';

import {
  BTCDaiRebalancingManagerContract,
  BTCETHRebalancingManagerContract,
  ETHDaiRebalancingManagerContract,
  HistoricalPriceFeedContract,
  MACOStrategyManagerContract,
  MACOStrategyManagerV2Contract,
  MovingAverageOracleContract,
  MovingAverageOracleV2Contract,
  OracleProxyContract,
} from 'set-protocol-strategies';

import ChaiSetup from '@test/helpers/chaiSetup';
import { DEFAULT_ACCOUNT } from '@src/constants/accounts';
import { Assertions } from '@src/assertions';
import { RebalancingManagerAPI } from '@src/api';
import {
  DEFAULT_AUCTION_PRICE_NUMERATOR,
  DEFAULT_AUCTION_PRICE_DENOMINATOR,
  E18,
  ONE_DAY_IN_SECONDS,
  ONE_HOUR_IN_SECONDS,
  TX_DEFAULTS,
} from '@src/constants';
import { ACCOUNTS } from '@src/constants/accounts';
import {
  addPriceCurveToCoreAsync,
  addPriceFeedOwnerToMedianizer,
  addWhiteListedTokenAsync,
  approveContractToOracleProxy,
  approveForTransferAsync,
  createDefaultRebalancingSetTokenAsync,
  deployBaseContracts,
  deployBtcDaiManagerContractAsync,
  deployBtcEthManagerContractAsync,
  deployConstantAuctionPriceCurveAsync,
  deployEthDaiManagerContractAsync,
  deployHistoricalPriceFeedAsync,
  deployLegacyMakerOracleAdapterAsync,
  deployLinearizedPriceDataSourceAsync,
  deployMedianizerAsync,
  deployMovingAverageOracleAsync,
  deployMovingAverageOracleV2Async,
  deployMovingAverageStrategyManagerAsync,
  deployMovingAverageStrategyManagerV2Async,
  deployOracleProxyAsync,
  deploySetTokenAsync,
  deployTimeSeriesFeedAsync,
  deployTokensSpecifyingDecimals,
  increaseChainTimeAsync,
  initializeMovingAverageStrategyManagerAsync,
  updateMedianizerPriceAsync,
} from '@test/helpers';
import { BigNumber } from '@src/util';
import { Address, ManagerType } from '@src/types/common';
import {
  BTCDAIRebalancingManagerWrapper,
  BTCETHRebalancingManagerWrapper,
  ETHDAIRebalancingManagerWrapper,
  MACOStrategyManagerWrapper
} from '@src/wrappers';
import {
  BTCDAIRebalancingManagerDetails,
  BTCETHRebalancingManagerDetails,
  ETHDAIRebalancingManagerDetails,
  MovingAverageManagerDetails,
} from '@src/types/strategies';

ChaiSetup.configure();
const chaiBigNumber = require('chai-bignumber');
chai.use(chaiBigNumber(BigNumber));
const { expect } = chai;
const contract = require('truffle-contract');
const web3 = new Web3('http://localhost:8545');
const { SetProtocolTestUtils: SetTestUtils, Web3Utils } = setProtocolUtils;
const web3Utils = new Web3Utils(web3);

const coreContract = contract(Core);
coreContract.setProvider(web3.currentProvider);
coreContract.defaults(TX_DEFAULTS);

let currentSnapshotId: number;


describe('RebalancingManagerAPI', () => {
  let core: CoreContract;
  let transferProxy: TransferProxyContract;
  let factory: SetTokenFactoryContract;
  let rebalancingFactory: RebalancingSetTokenFactoryContract;
  let constantAuctionPriceCurve: ConstantAuctionPriceCurveContract;
  let btcMedianizer: MedianContract;
  let ethMedianizer: MedianContract;
  let wrappedBTC: StandardTokenMockContract;
  let wrappedETH: StandardTokenMockContract;
  let dai: StandardTokenMockContract;
  let usdc: StandardTokenMockContract;
  let whitelist: WhiteListContract;

  let rebalancingManagerAPI: RebalancingManagerAPI;

  beforeAll(() => {
    ABIDecoder.addABI(coreContract.abi);
  });

  afterAll(() => {
    ABIDecoder.removeABI(coreContract.abi);
  });

  beforeEach(async () => {
    currentSnapshotId = await web3Utils.saveTestSnapshot();

    [core, transferProxy, , factory, rebalancingFactory, , whitelist] = await deployBaseContracts(web3);

    btcMedianizer = await deployMedianizerAsync(web3);
    await addPriceFeedOwnerToMedianizer(btcMedianizer, DEFAULT_ACCOUNT);
    ethMedianizer = await deployMedianizerAsync(web3);
    await addPriceFeedOwnerToMedianizer(ethMedianizer, DEFAULT_ACCOUNT);

    [wrappedBTC, wrappedETH, dai, usdc] = await deployTokensSpecifyingDecimals(
      4,
      [8, 18, 18, 6],
      web3,
      DEFAULT_ACCOUNT
    );
    await approveForTransferAsync(
      [wrappedBTC, wrappedETH, dai, usdc],
      transferProxy.address
    );
    await addWhiteListedTokenAsync(
      whitelist,
      wrappedBTC.address,
    );
    await addWhiteListedTokenAsync(
      whitelist,
      wrappedETH.address,
    );
    await addWhiteListedTokenAsync(
      whitelist,
      dai.address,
    );
    await addWhiteListedTokenAsync(
      whitelist,
      usdc.address,
    );

    constantAuctionPriceCurve = await deployConstantAuctionPriceCurveAsync(
      web3,
      DEFAULT_AUCTION_PRICE_NUMERATOR,
      DEFAULT_AUCTION_PRICE_DENOMINATOR,
    );

    addPriceCurveToCoreAsync(
      core,
      constantAuctionPriceCurve.address,
    );

    const assertions = new Assertions(web3);
    rebalancingManagerAPI = new RebalancingManagerAPI(web3, assertions);
  });

  afterEach(async () => {
    await web3Utils.revertToSnapshot(currentSnapshotId);
  });

  describe('BTCETHRebalancingManager', async () => {
    let btcethRebalancingManager: BTCETHRebalancingManagerContract;
    let btcMultiplier: BigNumber;
    let ethMultiplier: BigNumber;
    let auctionTimeToPivot: BigNumber;
    let maximumLowerThreshold: BigNumber;
    let minimumUpperThreshold: BigNumber;

    beforeEach(async () => {
      btcMultiplier = new BigNumber(1);
      ethMultiplier = new BigNumber(1);
      auctionTimeToPivot = ONE_DAY_IN_SECONDS;
      maximumLowerThreshold = new BigNumber(48);
      minimumUpperThreshold = new BigNumber(52);

      btcethRebalancingManager = await deployBtcEthManagerContractAsync(
        web3,
        core.address,
        btcMedianizer.address,
        ethMedianizer.address,
        wrappedBTC.address,
        wrappedETH.address,
        factory.address,
        constantAuctionPriceCurve.address,
        auctionTimeToPivot,
        [btcMultiplier, ethMultiplier],
        [maximumLowerThreshold, minimumUpperThreshold]
      );
    });

    describe('getBTCETHRebalancingManagerDetailsAsync', async () => {
      let subjectManagerAddress: Address;

      beforeEach(async () => {
        subjectManagerAddress = btcethRebalancingManager.address;
      });

      async function subject(): Promise<BTCETHRebalancingManagerDetails> {
        return await rebalancingManagerAPI.getBTCETHRebalancingManagerDetailsAsync(
          subjectManagerAddress,
        );
      }

      test('gets the correct core address', async () => {
        const details = await subject();
        expect(details.core).to.equal(core.address);
      });

      test('gets the correct btcPriceFeed address', async () => {
        const details = await subject();
        expect(details.btcPriceFeed).to.equal(btcMedianizer.address);
      });

      test('gets the correct ethPriceFeed address', async () => {
        const details = await subject();
        expect(details.ethPriceFeed).to.equal(ethMedianizer.address);
      });

      test('gets the correct btcAddress address', async () => {
        const details = await subject();
        expect(details.btcAddress).to.equal(wrappedBTC.address);
      });

      test('gets the correct ethAddress address', async () => {
        const details = await subject();
        expect(details.ethAddress).to.equal(wrappedETH.address);
      });

      test('gets the correct setTokenFactory address', async () => {
        const details = await subject();
        expect(details.setTokenFactory).to.equal(factory.address);
      });

      test('gets the correct btcMultiplier address', async () => {
        const details = await subject();
        expect(details.btcMultiplier).to.bignumber.equal(btcMultiplier);
      });

      test('gets the correct ethMultiplier address', async () => {
        const details = await subject();
        expect(details.ethMultiplier).to.bignumber.equal(ethMultiplier);
      });

      test('gets the correct auctionLibrary address', async () => {
        const details = await subject();
        expect(details.auctionLibrary).to.equal(constantAuctionPriceCurve.address);
      });

      test('gets the correct auctionTimeToPivot address', async () => {
        const details = await subject();
        expect(details.auctionTimeToPivot).to.bignumber.equal(auctionTimeToPivot);
      });

      test('gets the correct maximumLowerThreshold', async () => {
        const details = await subject();
        expect(details.maximumLowerThreshold).to.bignumber.equal(maximumLowerThreshold);
      });

      test('gets the correct minimumUpperThreshold', async () => {
        const details = await subject();
        expect(details.minimumUpperThreshold).to.bignumber.equal(minimumUpperThreshold);
      });
    });

    describe('proposeAsync', async () => {
      let rebalancingSetToken: RebalancingSetTokenContract;

      let proposalPeriod: BigNumber;
      let btcPrice: BigNumber;
      let ethPrice: BigNumber;
      let ethUnit: BigNumber;

      let initialAllocationToken: SetTokenContract;
      let timeFastForward: BigNumber;
      let nextRebalanceAvailableInSeconds: BigNumber;

      let subjectManagerType: BigNumber;
      let subjectRebalancingSetToken: Address;
      let subjectManagerAddress: Address;
      let subjectCaller: Address;

      const btcethManagerWrapper: BTCETHRebalancingManagerWrapper = new BTCETHRebalancingManagerWrapper(web3);

      beforeAll(async () => {
        btcPrice = new BigNumber(4082 * 10 ** 18);
        ethPrice = new BigNumber(128 * 10 ** 18);
        ethUnit = new BigNumber(28.999 * 10 ** 10);
      });

      beforeEach(async () => {
        initialAllocationToken = await deploySetTokenAsync(
          web3,
          core,
          factory.address,
          [wrappedBTC.address, wrappedETH.address],
          [new BigNumber(1).mul(btcMultiplier), ethUnit.mul(ethMultiplier)],
          new BigNumber(10 ** 10),
        );

        proposalPeriod = ONE_DAY_IN_SECONDS;
        rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
          web3,
          core,
          rebalancingFactory.address,
          btcethRebalancingManager.address,
          initialAllocationToken.address,
          proposalPeriod
        );

        timeFastForward = ONE_DAY_IN_SECONDS.add(1);
        await updateMedianizerPriceAsync(
          web3,
          btcMedianizer,
          btcPrice,
          SetTestUtils.generateTimestamp(1000),
        );

        await updateMedianizerPriceAsync(
          web3,
          ethMedianizer,
          ethPrice,
          SetTestUtils.generateTimestamp(1000),
        );

        subjectManagerType = ManagerType.BTCETH;
        subjectManagerAddress = btcethRebalancingManager.address;
        subjectRebalancingSetToken = rebalancingSetToken.address;
        subjectCaller = DEFAULT_ACCOUNT;

        const lastRebalancedTimestampSeconds = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
        const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
        nextRebalanceAvailableInSeconds = lastRebalancedTimestampSeconds.plus(rebalanceInterval);
      });

      afterEach(async () => {
        timeKeeper.reset();
      });

      async function subject(): Promise<string> {
        await increaseChainTimeAsync(web3, timeFastForward);
        timeKeeper.freeze(nextRebalanceAvailableInSeconds.toNumber() * 1000);
        return rebalancingManagerAPI.proposeAsync(
          subjectManagerType,
          subjectManagerAddress,
          subjectRebalancingSetToken,
          { from: subjectCaller },
        );
      }

      test('successfully proposes', async () => {
        await subject();
      });

      describe('when price trigger is not met', async () => {
        beforeAll(async () => {
          btcPrice = new BigNumber(3700 * 10 ** 18);
        });

        afterAll(async () => {
          btcPrice = new BigNumber(4082 * 10 ** 18);
        });

        test('throws', async () => {
          const btcAllocationAmount = new BigNumber(49);
          return expect(subject()).to.be.rejectedWith(
            `Current BTC allocation ${btcAllocationAmount.toString()}% must be outside allocation bounds ` +
            `${maximumLowerThreshold.toString()} and ${minimumUpperThreshold.toString()}.`
          );
        });
      });

      describe('when the RebalancingSet is not in Default state', async () => {
        beforeEach(async () => {
          // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          // Call propose to transition out of Default
          await btcethManagerWrapper.propose(btcethRebalancingManager.address, rebalancingSetToken.address);
        });

        test('throws', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Rebalancing token at ${rebalancingSetToken.address} must be in Default state to call that function.`
          );
        });
      });

      describe('when the rebalanceInterval has not elapsed', async () => {
        beforeEach(async () => {
          timeFastForward = new BigNumber(1);
          nextRebalanceAvailableInSeconds = nextRebalanceAvailableInSeconds.sub(1);
        });

        test('throws', async () => {
          const lastRebalanceTime = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
          const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
          const nextAvailableRebalance = lastRebalanceTime.add(rebalanceInterval).mul(1000);
          const nextRebalanceFormattedDate = moment(nextAvailableRebalance.toNumber())
          .format('dddd, MMMM Do YYYY, h:mm:ss a');

          return expect(subject()).to.be.rejectedWith(
            `Attempting to rebalance too soon. Rebalancing next ` +
            `available on ${nextRebalanceFormattedDate}`
          );
        });
      });

      describe('when invalid rebalancing set token is passed in', async () => {
        beforeEach(async () => {
          subjectRebalancingSetToken = ACCOUNTS[2].address;
        });

        test('throws', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Contract at ${subjectRebalancingSetToken} is not a valid Set token address.`
          );
        });
      });

      describe('when invalid rebalancing manager type is passed in', async () => {
        beforeEach(async () => {
          subjectManagerType = new BigNumber(4);
        });

        test('throws', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Passed manager type is not recognized.`
          );
        });
      });
    });
  });

  describe('MACOStrategyManager', async () => {
    let macoManager: MACOStrategyManagerContract;
    let movingAverageOracle: MovingAverageOracleContract;
    let initialStableCollateral: SetTokenContract;
    let initialRiskCollateral: SetTokenContract;
    let rebalancingSetToken: RebalancingSetTokenContract;

    let auctionTimeToPivot: BigNumber;
    let crossoverConfirmationMinTime: BigNumber;
    let crossoverConfirmationMaxTime: BigNumber;

    const priceFeedUpdateFrequency: BigNumber = new BigNumber(10);
    const initialMedianizerEthPrice: BigNumber = E18;
    const priceFeedDataDescription: string = '200DailyETHPrice';
    const seededPriceFeedPrices: BigNumber[] = [
      E18.mul(1),
      E18.mul(2),
      E18.mul(3),
      E18.mul(4),
      E18.mul(5),
    ];

    const movingAverageDays = new BigNumber(5);
    const stableCollateralUnit = new BigNumber(250);
    const stableCollateralNaturalUnit = new BigNumber(10 ** 12);

    const riskCollateralUnit = new BigNumber(10 ** 6);
    const riskCollateralNaturalUnit = new BigNumber(10 ** 6);
    const initializedProposalTimestamp = new BigNumber(0);

    beforeEach(async () => {
      crossoverConfirmationMinTime = ONE_HOUR_IN_SECONDS.mul(6);
      crossoverConfirmationMaxTime = ONE_HOUR_IN_SECONDS.mul(12);

      await updateMedianizerPriceAsync(
        web3,
        ethMedianizer,
        initialMedianizerEthPrice,
        SetTestUtils.generateTimestamp(1000),
      );

      const dailyPriceFeed: HistoricalPriceFeedContract = await deployHistoricalPriceFeedAsync(
        web3,
        priceFeedUpdateFrequency,
        ethMedianizer.address,
        priceFeedDataDescription,
        seededPriceFeedPrices
      );

      movingAverageOracle = await deployMovingAverageOracleAsync(
        web3,
        dailyPriceFeed.address,
        priceFeedDataDescription
      );

      auctionTimeToPivot = ONE_DAY_IN_SECONDS;

      // Create Stable Collateral Set
      initialStableCollateral = await deploySetTokenAsync(
        web3,
        core,
        factory.address,
        [usdc.address],
        [stableCollateralUnit],
        stableCollateralNaturalUnit,
      );

      // Create Risk Collateral Set
      initialRiskCollateral = await deploySetTokenAsync(
        web3,
        core,
        factory.address,
        [wrappedETH.address],
        [riskCollateralUnit],
        riskCollateralNaturalUnit,
      );

      macoManager = await deployMovingAverageStrategyManagerAsync(
        web3,
        core.address,
        movingAverageOracle.address,
        usdc.address,
        wrappedETH.address,
        initialStableCollateral.address,
        initialRiskCollateral.address,
        factory.address,
        constantAuctionPriceCurve.address,
        movingAverageDays,
        auctionTimeToPivot,
        crossoverConfirmationMinTime,
        crossoverConfirmationMaxTime,
      );

      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingFactory.address,
        macoManager.address,
        initialRiskCollateral.address,
        ONE_DAY_IN_SECONDS,
      );

      await initializeMovingAverageStrategyManagerAsync(
        macoManager,
        rebalancingSetToken.address
      );
    });

    describe('getMovingAverageManagerDetailsAsync', async () => {
      let subjectManagerAddress: Address;

      beforeEach(async () => {
        subjectManagerAddress = macoManager.address;
      });

      async function subject(): Promise<MovingAverageManagerDetails> {
        return await rebalancingManagerAPI.getMovingAverageManagerDetailsAsync(
          ManagerType.MACO,
          subjectManagerAddress,
        );
      }

      test('gets the correct auctionLibrary address', async () => {
        const details = await subject();
        expect(details.auctionLibrary).to.equal(constantAuctionPriceCurve.address);
      });

      test('gets the correct auctionTimeToPivot address', async () => {
        const details = await subject();
        expect(details.auctionTimeToPivot).to.bignumber.equal(auctionTimeToPivot);
      });

      test('gets the correct core address', async () => {
        const details = await subject();
        expect(details.core).to.equal(core.address);
      });

      test('gets the correct lastCrossoverConfirmationTimestamp', async () => {
        const details = await subject();
        expect(details.lastCrossoverConfirmationTimestamp).to.bignumber.equal(initializedProposalTimestamp);
      });

      test('gets the correct movingAverageDays', async () => {
        const details = await subject();
        expect(details.movingAverageDays).to.bignumber.equal(movingAverageDays);
      });

      test('gets the correct movingAveragePriceFeed', async () => {
        const details = await subject();
        expect(details.movingAveragePriceFeed).to.equal(movingAverageOracle.address);
      });

      test('gets the correct rebalancingSetToken', async () => {
        const details = await subject();
        expect(details.rebalancingSetToken).to.equal(rebalancingSetToken.address);
      });

      test('gets the correct riskAsset', async () => {
        const details = await subject();
        expect(details.riskAsset).to.equal(wrappedETH.address);
      });

      test('gets the correct riskCollateral', async () => {
        const details = await subject();
        expect(details.riskCollateral).to.equal(initialRiskCollateral.address);
      });

      test('gets the correct setTokenFactory', async () => {
        const details = await subject();
        expect(details.setTokenFactory).to.equal(factory.address);
      });

      test('gets the correct stableAsset', async () => {
        const details = await subject();
        expect(details.stableAsset).to.equal(usdc.address);
      });

      test('gets the correct stableCollateral', async () => {
        const details = await subject();
        expect(details.stableCollateral).to.equal(initialStableCollateral.address);
      });

      test('gets the correct crossoverConfirmationMinTime', async () => {
        const details = await subject();
        expect(details.crossoverConfirmationMinTime).to.bignumber.equal(crossoverConfirmationMinTime);
      });

      test('gets the correct crossoverConfirmationMaxTime', async () => {
        const details = await subject();
        expect(details.crossoverConfirmationMaxTime).to.bignumber.equal(crossoverConfirmationMaxTime);
      });
    });

    describe('getLastCrossoverConfirmationTimestampAsync', async () => {
      let subjectManagerAddress: Address;

      beforeEach(async () => {
        subjectManagerAddress = macoManager.address;
      });

      async function subject(): Promise<BigNumber> {
        return await rebalancingManagerAPI.getLastCrossoverConfirmationTimestampAsync(
          subjectManagerAddress,
        );
      }

      test('gets the correct lastCrossoverConfirmationTimestamp', async () => {
        const lastCrossoverConfirmationTimestamp = await subject();
        expect(lastCrossoverConfirmationTimestamp).to.bignumber.equal(initializedProposalTimestamp);
      });
    });

    describe('initiateCrossoverProposeAsync', async () => {
      let subjectManagerAddress: Address;
      let subjectCaller: Address;

      let nextRebalanceAvailableInSeconds: BigNumber;
      const macoManagerWrapper: MACOStrategyManagerWrapper = new MACOStrategyManagerWrapper(web3);

      beforeEach(async () => {
        subjectManagerAddress = macoManager.address;
        subjectCaller = DEFAULT_ACCOUNT;

        const lastRebalancedTimestampSeconds = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
        const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
        nextRebalanceAvailableInSeconds = lastRebalancedTimestampSeconds.plus(rebalanceInterval);
      });

      afterEach(async () => {
        timeKeeper.reset();
      });

      async function subject(): Promise<string> {
        return await rebalancingManagerAPI.initiateCrossoverProposeAsync(
          ManagerType.MACO,
          subjectManagerAddress,
          { from: subjectCaller },
        );
      }

      describe('when more than 12 hours has elapsed since the last Proposal timestamp', async () => {
        beforeEach(async () => {
          // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(1000),
          );

          // Free time at the rebalance interval minimum
          timeKeeper.freeze(nextRebalanceAvailableInSeconds.toNumber() * 1000);
        });

        test('calls initialPropose and sets the lastCrossoverConfirmationTimestamp properly', async () => {
          const txnHash = await subject();
          const { blockNumber } = await web3.eth.getTransactionReceipt(txnHash);
          const { timestamp } = await web3.eth.getBlock(blockNumber);

          const lastTimestamp = await macoManagerWrapper.lastCrossoverConfirmationTimestamp(
            subjectManagerAddress,
          );
          expect(lastTimestamp).to.bignumber.equal(timestamp);
        });
      });

      describe('when the RebalancingSet is not in Default state', async () => {
        beforeEach(async () => {
          // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(1000),
          );

          // Call initialPropose to set the timestamp
          await macoManagerWrapper.initialPropose(subjectManagerAddress);

          // Elapse signal confirmation period
          await increaseChainTimeAsync(web3, ONE_HOUR_IN_SECONDS.mul(7));

          // Put the rebalancing set into proposal state
          await macoManagerWrapper.confirmPropose(subjectManagerAddress);

          // Freeze the time at rebalance interval + 3 hours
          const newDesiredTimestamp = nextRebalanceAvailableInSeconds.plus(ONE_HOUR_IN_SECONDS.mul(7));
          timeKeeper.freeze(newDesiredTimestamp.toNumber() * 1000);
        });

        test('throws', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Rebalancing token at ${rebalancingSetToken.address} must be in Default state to call that function.`
          );
        });
      });

      describe('when insufficient time has elapsed since the last rebalance', async () => {
        beforeEach(async () => {
          // Freeze the time at rebalance interval
          const lastRebalancedTimestampSeconds = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
          timeKeeper.freeze(lastRebalancedTimestampSeconds.toNumber() * 1000);
        });

        test('throws', async () => {
          const lastRebalanceTime = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
          const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
          const nextAvailableRebalance = lastRebalanceTime.add(rebalanceInterval).mul(1000);
          const nextRebalanceFormattedDate = moment(nextAvailableRebalance.toNumber())
          .format('dddd, MMMM Do YYYY, h:mm:ss a');

          return expect(subject()).to.be.rejectedWith(
            `Attempting to rebalance too soon. Rebalancing next ` +
            `available on ${nextRebalanceFormattedDate}`
          );
        });
      });

      describe('when no MA crossover when rebalancing Set is risk collateral', async () => {
        let currentPrice: BigNumber;

        beforeEach(async () => {
          currentPrice = initialMedianizerEthPrice.mul(5);

          // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.mul(5),
            SetTestUtils.generateTimestamp(1000),
          );

          // Freeze the time at rebalance interval
          timeKeeper.freeze(nextRebalanceAvailableInSeconds.toNumber() * 1000);
        });

        test('throws', async () => {
          const movingAverage = new BigNumber(await movingAverageOracle.read.callAsync(movingAverageDays));

          return expect(subject()).to.be.rejectedWith(
            `Current Price ${currentPrice.toString()} must be less than Moving Average ${movingAverage.toString()}`
          );
        });
      });

      describe('when no MA crossover when rebalancing Set is stable collateral', async () => {
        let currentPriceThatIsBelowMA: BigNumber;

        beforeEach(async () => {

          macoManager = await deployMovingAverageStrategyManagerAsync(
            web3,
            core.address,
            movingAverageOracle.address,
            usdc.address,
            wrappedETH.address,
            initialStableCollateral.address,
            initialRiskCollateral.address,
            factory.address,
            constantAuctionPriceCurve.address,
            movingAverageDays,
            auctionTimeToPivot,
            crossoverConfirmationMinTime,
            crossoverConfirmationMaxTime,
          );

          rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
            web3,
            core,
            rebalancingFactory.address,
            macoManager.address,
            initialStableCollateral.address,
            ONE_DAY_IN_SECONDS,
          );

          await initializeMovingAverageStrategyManagerAsync(
            macoManager,
            rebalancingSetToken.address
          );

          currentPriceThatIsBelowMA = initialMedianizerEthPrice.div(10);

          // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            currentPriceThatIsBelowMA,
            SetTestUtils.generateTimestamp(1000),
          );

          subjectManagerAddress = macoManager.address;

          // Freeze the time at rebalance interval
          const lastRebalancedTimestampSeconds = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
          const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
          nextRebalanceAvailableInSeconds = lastRebalancedTimestampSeconds.plus(rebalanceInterval);
          timeKeeper.freeze(nextRebalanceAvailableInSeconds.toNumber() * 1000);
        });

        test('throws', async () => {
          const movingAverage = new BigNumber(await movingAverageOracle.read.callAsync(movingAverageDays));

          return expect(subject()).to.be.rejectedWith(
            `Current Price ${currentPriceThatIsBelowMA.toString()} must be ` +
            `greater than Moving Average ${movingAverage.toString()}`
          );
        });
      });
    });

    describe('confirmCrossoverProposeAsync', async () => {
      let subjectManagerAddress: Address;
      let subjectCaller: Address;

      let nextRebalanceAvailableInSeconds: BigNumber;
      const macoManagerWrapper: MACOStrategyManagerWrapper = new MACOStrategyManagerWrapper(web3);

      beforeEach(async () => {
        subjectManagerAddress = macoManager.address;
        subjectCaller = DEFAULT_ACCOUNT;

        const lastRebalancedTimestampSeconds = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
        const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
        nextRebalanceAvailableInSeconds = lastRebalancedTimestampSeconds.plus(rebalanceInterval);
      });

      afterEach(async () => {
        timeKeeper.reset();
      });

      async function subject(): Promise<string> {
        return await rebalancingManagerAPI.confirmCrossoverProposeAsync(
          ManagerType.MACO,
          subjectManagerAddress,
          { from: subjectCaller },
        );
      }

      describe('when 6 hours has elapsed since the lastCrossoverConfirmationTimestamp', async () => {
        beforeEach(async () => {
           // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(1000),
          );

          // Call initialPropose to set the timestamp
          await macoManagerWrapper.initialPropose(subjectManagerAddress);

          // Elapse 7 hours
          await increaseChainTimeAsync(web3, ONE_HOUR_IN_SECONDS.mul(7));

          // Need to perform a transaction to further the timestamp
          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(2000),
          );

          // Freeze the time at rebalance interval + 7 hours
          const lastCrossoverConfirmationTimestamp =
            await macoManager.lastCrossoverConfirmationTimestamp.callAsync(macoManager);
          const newDesiredTimestamp = lastCrossoverConfirmationTimestamp.plus(ONE_HOUR_IN_SECONDS.mul(7));
          timeKeeper.freeze(newDesiredTimestamp.toNumber() * 1000);
        });

        test('sets the rebalancing Set into proposal period', async () => {
          await subject();
          const proposalStateEnum = new BigNumber(1);
          const rebalancingSetState = await rebalancingSetToken.rebalanceState.callAsync();

          expect(rebalancingSetState).to.bignumber.equal(proposalStateEnum);
        });
      });

      describe('when more than 12 hours has not elapsed since the lastCrossoverConfirmationTimestamp', async () => {
        beforeEach(async () => {
           // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(1000),
          );

          // Call initialPropose to set the timestamp
          await macoManagerWrapper.initialPropose(subjectManagerAddress);

          // Elapse 3 hours
          await increaseChainTimeAsync(web3, ONE_HOUR_IN_SECONDS.mul(13));

          // Need to perform a transaction to further the timestamp
          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(2000),
          );

          // Freeze the time at rebalance interval + 3 hours
          const lastCrossoverConfirmationTimestamp =
            await macoManager.lastCrossoverConfirmationTimestamp.callAsync(macoManager);
          const newDesiredTimestamp = lastCrossoverConfirmationTimestamp.plus(ONE_HOUR_IN_SECONDS.mul(3));
          timeKeeper.freeze(newDesiredTimestamp.toNumber() * 1000);
        });

        test('throws', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Confirm Crossover Propose is not called in the confirmation period since last proposal timestamp`
          );
        });
      });

      describe('when 6 hours has not elapsed since the lastCrossoverConfirmationTimestamp', async () => {
        beforeEach(async () => {
           // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(1000),
          );

          // Call initialPropose to set the timestamp
          await macoManagerWrapper.initialPropose(subjectManagerAddress);

          // Elapse 3 hours
          await increaseChainTimeAsync(web3, ONE_HOUR_IN_SECONDS.mul(3));

          // Need to perform a transaction to further the timestamp
          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(2000),
          );

          // Freeze the time at rebalance interval + 3 hours
          const lastCrossoverConfirmationTimestamp =
            await macoManager.lastCrossoverConfirmationTimestamp.callAsync(macoManager);
          const newDesiredTimestamp = lastCrossoverConfirmationTimestamp.plus(ONE_HOUR_IN_SECONDS.mul(3));
          timeKeeper.freeze(newDesiredTimestamp.toNumber() * 1000);
        });

        test('throws', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Confirm Crossover Propose is not called in the confirmation period since last proposal timestamp`
          );
        });
      });

      describe('when the RebalancingSet is not in Default state', async () => {
        beforeEach(async () => {
          // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(1000),
          );

          // Call initialPropose to set the timestamp
          await macoManagerWrapper.initialPropose(subjectManagerAddress);

          // Elapse signal confirmation period
          await increaseChainTimeAsync(web3, ONE_HOUR_IN_SECONDS.mul(7));

          // Put the rebalancing set into proposal state
          await macoManagerWrapper.confirmPropose(subjectManagerAddress);

          // Freeze the time at rebalance interval + 3 hours
          const newDesiredTimestamp = nextRebalanceAvailableInSeconds.plus(ONE_HOUR_IN_SECONDS.mul(7));
          timeKeeper.freeze(newDesiredTimestamp.toNumber() * 1000);
        });

        test('throws', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Rebalancing token at ${rebalancingSetToken.address} must be in Default state to call that function.`
          );
        });
      });

      describe('when insufficient time has elapsed since the last rebalance', async () => {
        beforeEach(async () => {
          // Freeze the time at rebalance interval
          const lastRebalancedTimestampSeconds = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
          timeKeeper.freeze(lastRebalancedTimestampSeconds.toNumber() * 1000);
        });

        test('throws', async () => {
          const lastRebalanceTime = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
          const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
          const nextAvailableRebalance = lastRebalanceTime.add(rebalanceInterval).mul(1000);
          const nextRebalanceFormattedDate = moment(nextAvailableRebalance.toNumber())
          .format('dddd, MMMM Do YYYY, h:mm:ss a');

          return expect(subject()).to.be.rejectedWith(
            `Attempting to rebalance too soon. Rebalancing next ` +
            `available on ${nextRebalanceFormattedDate}`
          );
        });
      });

      describe('when no MA crossover when rebalancing Set is risk collateral', async () => {
        let currentPrice: BigNumber;

        beforeEach(async () => {
          currentPrice = initialMedianizerEthPrice.mul(5);

          // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            currentPrice,
            SetTestUtils.generateTimestamp(1000),
          );

          // Freeze the time at rebalance interval
          timeKeeper.freeze(nextRebalanceAvailableInSeconds.toNumber() * 1000);
        });

        test('throws', async () => {
          const movingAverage = new BigNumber(await movingAverageOracle.read.callAsync(movingAverageDays));

          return expect(subject()).to.be.rejectedWith(
            `Current Price ${currentPrice.toString()} must be less than Moving Average ${movingAverage.toString()}`
          );
        });
      });

      describe('when no MA crossover when rebalancing Set is stable collateral', async () => {
        let currentPriceThatIsBelowMA: BigNumber;

        beforeEach(async () => {

          macoManager = await deployMovingAverageStrategyManagerAsync(
            web3,
            core.address,
            movingAverageOracle.address,
            usdc.address,
            wrappedETH.address,
            initialStableCollateral.address,
            initialRiskCollateral.address,
            factory.address,
            constantAuctionPriceCurve.address,
            movingAverageDays,
            auctionTimeToPivot,
            crossoverConfirmationMinTime,
            crossoverConfirmationMaxTime,
          );

          rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
            web3,
            core,
            rebalancingFactory.address,
            macoManager.address,
            initialStableCollateral.address,
            ONE_DAY_IN_SECONDS,
          );

          await initializeMovingAverageStrategyManagerAsync(
            macoManager,
            rebalancingSetToken.address
          );

          currentPriceThatIsBelowMA = initialMedianizerEthPrice.div(10);

          // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            currentPriceThatIsBelowMA,
            SetTestUtils.generateTimestamp(1000),
          );

          subjectManagerAddress = macoManager.address;

          // Freeze the time at rebalance interval
          const lastRebalancedTimestampSeconds = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
          const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
          nextRebalanceAvailableInSeconds = lastRebalancedTimestampSeconds.plus(rebalanceInterval);
          timeKeeper.freeze(nextRebalanceAvailableInSeconds.toNumber() * 1000);
        });

        test('throws', async () => {
          const movingAverage = new BigNumber(await movingAverageOracle.read.callAsync(movingAverageDays));

          return expect(subject()).to.be.rejectedWith(
            `Current Price ${currentPriceThatIsBelowMA.toString()} must be ` +
            `greater than Moving Average ${movingAverage.toString()}`
          );
        });
      });
    });
  });

  describe.only('MACOStrategyManagerV2', async () => {
    let macoManager: MACOStrategyManagerV2Contract;
    let ethOracleProxy: OracleProxyContract;
    let movingAverageOracle: MovingAverageOracleV2Contract;
    let initialStableCollateral: SetTokenContract;
    let initialRiskCollateral: SetTokenContract;
    let rebalancingSetToken: RebalancingSetTokenContract;

    let auctionTimeToPivot: BigNumber;
    let crossoverConfirmationMinTime: BigNumber;
    let crossoverConfirmationMaxTime: BigNumber;

    const seededPriceFeedPrices: BigNumber[] = [
      E18.mul(1),
      E18.mul(2),
      E18.mul(3),
      E18.mul(4),
      E18.mul(5),
    ];
    const initialMedianizerEthPrice: BigNumber = E18;
    const priceFeedDataDescription: string = '200DailyETHPrice';

    const movingAverageDays = new BigNumber(5);
    const stableCollateralUnit = new BigNumber(250);
    const stableCollateralNaturalUnit = new BigNumber(10 ** 12);

    const riskCollateralUnit = new BigNumber(10 ** 6);
    const riskCollateralNaturalUnit = new BigNumber(10 ** 6);
    const initializedProposalTimestamp = new BigNumber(0);

    beforeEach(async () => {
      crossoverConfirmationMinTime = ONE_HOUR_IN_SECONDS.mul(6);
      crossoverConfirmationMaxTime = ONE_HOUR_IN_SECONDS.mul(12);

      await updateMedianizerPriceAsync(
        web3,
        ethMedianizer,
        initialMedianizerEthPrice,
        SetTestUtils.generateTimestamp(1000),
      );

      const medianizerAdapter = await deployLegacyMakerOracleAdapterAsync(
        web3,
        ethMedianizer.address
      );

      ethOracleProxy = await deployOracleProxyAsync(
        web3,
        medianizerAdapter.address
      );

      const dataSource = await deployLinearizedPriceDataSourceAsync(
        web3,
        ethOracleProxy.address,
        ONE_HOUR_IN_SECONDS,
        ''
      );

      await approveContractToOracleProxy(
        ethOracleProxy,
        dataSource.address
      );

      const timeSeriesFeed = await deployTimeSeriesFeedAsync(
        web3,
        dataSource.address,
        seededPriceFeedPrices
      );

      movingAverageOracle = await deployMovingAverageOracleV2Async(
        web3,
        timeSeriesFeed.address,
        priceFeedDataDescription
      );

      auctionTimeToPivot = ONE_DAY_IN_SECONDS;

      // Create Stable Collateral Set
      initialStableCollateral = await deploySetTokenAsync(
        web3,
        core,
        factory.address,
        [usdc.address],
        [stableCollateralUnit],
        stableCollateralNaturalUnit,
      );

      // Create Risk Collateral Set
      initialRiskCollateral = await deploySetTokenAsync(
        web3,
        core,
        factory.address,
        [wrappedETH.address],
        [riskCollateralUnit],
        riskCollateralNaturalUnit,
      );

      macoManager = await deployMovingAverageStrategyManagerV2Async(
        web3,
        core.address,
        movingAverageOracle.address,
        ethOracleProxy.address,
        usdc.address,
        wrappedETH.address,
        initialStableCollateral.address,
        initialRiskCollateral.address,
        factory.address,
        constantAuctionPriceCurve.address,
        movingAverageDays,
        auctionTimeToPivot,
        crossoverConfirmationMinTime,
        crossoverConfirmationMaxTime,
      );

      await approveContractToOracleProxy(
        ethOracleProxy,
        macoManager.address
      );

      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingFactory.address,
        macoManager.address,
        initialRiskCollateral.address,
        ONE_DAY_IN_SECONDS,
      );

      await initializeMovingAverageStrategyManagerAsync(
        macoManager,
        rebalancingSetToken.address
      );
    });

    describe('getMovingAverageManagerDetailsAsync', async () => {
      let subjectManagerAddress: Address;

      beforeEach(async () => {
        subjectManagerAddress = macoManager.address;
      });

      async function subject(): Promise<MovingAverageManagerDetails> {
        return await rebalancingManagerAPI.getMovingAverageManagerDetailsAsync(
          ManagerType.MACOV2,
          subjectManagerAddress,
        );
      }

      test('gets the correct auctionLibrary address', async () => {
        const details = await subject();
        expect(details.auctionLibrary).to.equal(constantAuctionPriceCurve.address);
      });

      test('gets the correct auctionTimeToPivot address', async () => {
        const details = await subject();
        expect(details.auctionTimeToPivot).to.bignumber.equal(auctionTimeToPivot);
      });

      test('gets the correct core address', async () => {
        const details = await subject();
        expect(details.core).to.equal(core.address);
      });

      test('gets the correct lastCrossoverConfirmationTimestamp', async () => {
        const details = await subject();
        expect(details.lastCrossoverConfirmationTimestamp).to.bignumber.equal(initializedProposalTimestamp);
      });

      test('gets the correct movingAverageDays', async () => {
        const details = await subject();
        expect(details.movingAverageDays).to.bignumber.equal(movingAverageDays);
      });

      test('gets the correct movingAveragePriceFeed', async () => {
        const details = await subject();
        expect(details.movingAveragePriceFeed).to.equal(movingAverageOracle.address);
      });

      test('gets the correct rebalancingSetToken', async () => {
        const details = await subject();
        expect(details.rebalancingSetToken).to.equal(rebalancingSetToken.address);
      });

      test('gets the correct riskAsset', async () => {
        const details = await subject();
        expect(details.riskAsset).to.equal(wrappedETH.address);
      });

      test('gets the correct riskCollateral', async () => {
        const details = await subject();
        expect(details.riskCollateral).to.equal(initialRiskCollateral.address);
      });

      test('gets the correct setTokenFactory', async () => {
        const details = await subject();
        expect(details.setTokenFactory).to.equal(factory.address);
      });

      test('gets the correct stableAsset', async () => {
        const details = await subject();
        expect(details.stableAsset).to.equal(usdc.address);
      });

      test('gets the correct stableCollateral', async () => {
        const details = await subject();
        expect(details.stableCollateral).to.equal(initialStableCollateral.address);
      });

      test('gets the correct crossoverConfirmationMinTime', async () => {
        const details = await subject();
        expect(details.crossoverConfirmationMinTime).to.bignumber.equal(crossoverConfirmationMinTime);
      });

      test('gets the correct crossoverConfirmationMaxTime', async () => {
        const details = await subject();
        expect(details.crossoverConfirmationMaxTime).to.bignumber.equal(crossoverConfirmationMaxTime);
      });
    });

    describe('getLastCrossoverConfirmationTimestampAsync', async () => {
      let subjectManagerAddress: Address;

      beforeEach(async () => {
        subjectManagerAddress = macoManager.address;
      });

      async function subject(): Promise<BigNumber> {
        return await rebalancingManagerAPI.getLastCrossoverConfirmationTimestampAsync(
          subjectManagerAddress,
        );
      }

      test('gets the correct lastCrossoverConfirmationTimestamp', async () => {
        const lastCrossoverConfirmationTimestamp = await subject();
        expect(lastCrossoverConfirmationTimestamp).to.bignumber.equal(initializedProposalTimestamp);
      });
    });

    describe('initiateCrossoverProposeAsync', async () => {
      let subjectManagerAddress: Address;
      let subjectCaller: Address;

      let nextRebalanceAvailableInSeconds: BigNumber;
      const macoManagerWrapper: MACOStrategyManagerWrapper = new MACOStrategyManagerWrapper(web3);

      beforeEach(async () => {
        subjectManagerAddress = macoManager.address;
        subjectCaller = DEFAULT_ACCOUNT;

        const lastRebalancedTimestampSeconds = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
        const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
        nextRebalanceAvailableInSeconds = lastRebalancedTimestampSeconds.plus(rebalanceInterval);
      });

      afterEach(async () => {
        timeKeeper.reset();
      });

      async function subject(): Promise<string> {
        return await rebalancingManagerAPI.initiateCrossoverProposeAsync(
          ManagerType.MACOV2,
          subjectManagerAddress,
          { from: subjectCaller },
        );
      }

      describe('when more than 12 hours has elapsed since the last Proposal timestamp', async () => {
        beforeEach(async () => {
          // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(1000),
          );

          // Free time at the rebalance interval minimum
          timeKeeper.freeze(nextRebalanceAvailableInSeconds.toNumber() * 1000);
        });

        test('calls initialPropose and sets the lastCrossoverConfirmationTimestamp properly', async () => {
          const txnHash = await subject();
          const { blockNumber } = await web3.eth.getTransactionReceipt(txnHash);
          const { timestamp } = await web3.eth.getBlock(blockNumber);

          const lastTimestamp = await macoManagerWrapper.lastCrossoverConfirmationTimestamp(
            subjectManagerAddress,
          );
          expect(lastTimestamp).to.bignumber.equal(timestamp);
        });
      });

      describe('when the RebalancingSet is not in Default state', async () => {
        beforeEach(async () => {
          // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(1000),
          );

          // Call initialPropose to set the timestamp
          await macoManagerWrapper.initialPropose(subjectManagerAddress);

          // Elapse signal confirmation period
          await increaseChainTimeAsync(web3, ONE_HOUR_IN_SECONDS.mul(7));

          // Put the rebalancing set into proposal state
          await macoManagerWrapper.confirmPropose(subjectManagerAddress);

          // Freeze the time at rebalance interval + 3 hours
          const newDesiredTimestamp = nextRebalanceAvailableInSeconds.plus(ONE_HOUR_IN_SECONDS.mul(7));
          timeKeeper.freeze(newDesiredTimestamp.toNumber() * 1000);
        });

        test('throws', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Rebalancing token at ${rebalancingSetToken.address} must be in Default state to call that function.`
          );
        });
      });

      describe('when insufficient time has elapsed since the last rebalance', async () => {
        beforeEach(async () => {
          // Freeze the time at rebalance interval
          const lastRebalancedTimestampSeconds = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
          timeKeeper.freeze(lastRebalancedTimestampSeconds.toNumber() * 1000);
        });

        test('throws', async () => {
          const lastRebalanceTime = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
          const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
          const nextAvailableRebalance = lastRebalanceTime.add(rebalanceInterval).mul(1000);
          const nextRebalanceFormattedDate = moment(nextAvailableRebalance.toNumber())
          .format('dddd, MMMM Do YYYY, h:mm:ss a');

          return expect(subject()).to.be.rejectedWith(
            `Attempting to rebalance too soon. Rebalancing next ` +
            `available on ${nextRebalanceFormattedDate}`
          );
        });
      });
    });

    describe('confirmCrossoverProposeAsync', async () => {
      let subjectManagerAddress: Address;
      let subjectCaller: Address;
      let nextRebalanceAvailableInSeconds: BigNumber;

      const macoManagerWrapper: MACOStrategyManagerWrapper = new MACOStrategyManagerWrapper(web3);

      beforeEach(async () => {
        subjectManagerAddress = macoManager.address;
        subjectCaller = DEFAULT_ACCOUNT;

        const lastRebalancedTimestampSeconds = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
        const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
        nextRebalanceAvailableInSeconds = lastRebalancedTimestampSeconds.plus(rebalanceInterval);
      });

      afterEach(async () => {
        timeKeeper.reset();
      });

      async function subject(): Promise<string> {
        return await rebalancingManagerAPI.confirmCrossoverProposeAsync(
          ManagerType.MACOV2,
          subjectManagerAddress,
          { from: subjectCaller },
        );
      }

      describe('when 6 hours has elapsed since the lastCrossoverConfirmationTimestamp', async () => {
        beforeEach(async () => {
           // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(1000),
          );

          // Call initialPropose to set the timestamp
          await macoManagerWrapper.initialPropose(subjectManagerAddress);

          // Elapse 7 hours
          await increaseChainTimeAsync(web3, ONE_HOUR_IN_SECONDS.mul(7));

          // Need to perform a transaction to further the timestamp
          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(2000),
          );

          // Freeze the time at rebalance interval + 7 hours
          const lastCrossoverConfirmationTimestamp =
            await macoManager.lastCrossoverConfirmationTimestamp.callAsync(macoManager);
          const newDesiredTimestamp = lastCrossoverConfirmationTimestamp.plus(ONE_HOUR_IN_SECONDS.mul(7));
          timeKeeper.freeze(newDesiredTimestamp.toNumber() * 1000);
        });

        test('sets the rebalancing Set into proposal period', async () => {
          await subject();
          const proposalStateEnum = new BigNumber(1);
          const rebalancingSetState = await rebalancingSetToken.rebalanceState.callAsync();

          expect(rebalancingSetState).to.bignumber.equal(proposalStateEnum);
        });
      });

      describe('when more than 12 hours has not elapsed since the lastCrossoverConfirmationTimestamp', async () => {
        beforeEach(async () => {
           // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(1000),
          );

          // Call initialPropose to set the timestamp
          await macoManagerWrapper.initialPropose(subjectManagerAddress);

          // Elapse 3 hours
          await increaseChainTimeAsync(web3, ONE_HOUR_IN_SECONDS.mul(13));

          // Need to perform a transaction to further the timestamp
          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(2000),
          );

          // Freeze the time at rebalance interval + 3 hours
          const lastCrossoverConfirmationTimestamp =
            await macoManager.lastCrossoverConfirmationTimestamp.callAsync(macoManager);
          const newDesiredTimestamp = lastCrossoverConfirmationTimestamp.plus(ONE_HOUR_IN_SECONDS.mul(3));
          timeKeeper.freeze(newDesiredTimestamp.toNumber() * 1000);
        });

        test('throws', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Confirm Crossover Propose is not called in the confirmation period since last proposal timestamp`
          );
        });
      });

      describe('when 6 hours has not elapsed since the lastCrossoverConfirmationTimestamp', async () => {
        beforeEach(async () => {
           // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(1000),
          );

          // Call initialPropose to set the timestamp
          await macoManagerWrapper.initialPropose(subjectManagerAddress);

          // Elapse 3 hours
          await increaseChainTimeAsync(web3, ONE_HOUR_IN_SECONDS.mul(3));

          // Need to perform a transaction to further the timestamp
          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(2000),
          );

          // Freeze the time at rebalance interval + 3 hours
          const lastCrossoverConfirmationTimestamp =
            await macoManager.lastCrossoverConfirmationTimestamp.callAsync(macoManager);
          const newDesiredTimestamp = lastCrossoverConfirmationTimestamp.plus(ONE_HOUR_IN_SECONDS.mul(3));
          timeKeeper.freeze(newDesiredTimestamp.toNumber() * 1000);
        });

        test('throws', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Confirm Crossover Propose is not called in the confirmation period since last proposal timestamp`
          );
        });
      });

      describe('when the RebalancingSet is not in Default state', async () => {
        beforeEach(async () => {
          // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          await updateMedianizerPriceAsync(
            web3,
            ethMedianizer,
            initialMedianizerEthPrice.div(10),
            SetTestUtils.generateTimestamp(1000),
          );

          // Call initialPropose to set the timestamp
          await macoManagerWrapper.initialPropose(subjectManagerAddress);

          // Elapse signal confirmation period
          await increaseChainTimeAsync(web3, ONE_HOUR_IN_SECONDS.mul(7));

          // Put the rebalancing set into proposal state
          await macoManagerWrapper.confirmPropose(subjectManagerAddress);

          // Freeze the time at rebalance interval + 3 hours
          const newDesiredTimestamp = nextRebalanceAvailableInSeconds.plus(ONE_HOUR_IN_SECONDS.mul(7));
          timeKeeper.freeze(newDesiredTimestamp.toNumber() * 1000);
        });

        test('throws', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Rebalancing token at ${rebalancingSetToken.address} must be in Default state to call that function.`
          );
        });
      });

      describe('when insufficient time has elapsed since the last rebalance', async () => {
        beforeEach(async () => {
          // Freeze the time at rebalance interval
          const lastRebalancedTimestampSeconds = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
          timeKeeper.freeze(lastRebalancedTimestampSeconds.toNumber() * 1000);
        });

        test('throws', async () => {
          const lastRebalanceTime = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
          const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
          const nextAvailableRebalance = lastRebalanceTime.add(rebalanceInterval).mul(1000);
          const nextRebalanceFormattedDate = moment(nextAvailableRebalance.toNumber())
          .format('dddd, MMMM Do YYYY, h:mm:ss a');

          return expect(subject()).to.be.rejectedWith(
            `Attempting to rebalance too soon. Rebalancing next ` +
            `available on ${nextRebalanceFormattedDate}`
          );
        });
      });
    });
  });

  describe('BTCDAIRebalancingManager', async () => {
    let btcDaiRebalancingManager: BTCDaiRebalancingManagerContract;
    let btcMultiplier: BigNumber;
    let daiMultiplier: BigNumber;
    let auctionTimeToPivot: BigNumber;
    let maximumLowerThreshold: BigNumber;
    let minimumUpperThreshold: BigNumber;

    beforeEach(async () => {
      btcMultiplier = new BigNumber(1);
      daiMultiplier = new BigNumber(1);
      auctionTimeToPivot = ONE_DAY_IN_SECONDS;
      maximumLowerThreshold = new BigNumber(47);
      minimumUpperThreshold = new BigNumber(55);

      btcDaiRebalancingManager = await deployBtcDaiManagerContractAsync(
        web3,
        core.address,
        btcMedianizer.address,
        dai.address,
        wrappedBTC.address,
        factory.address,
        constantAuctionPriceCurve.address,
        auctionTimeToPivot,
        [btcMultiplier, daiMultiplier],
        [maximumLowerThreshold, minimumUpperThreshold]
      );
    });

    describe('getRebalancingManagerDetailsAsync', async () => {
      let subjectManagerAddress: Address;

      beforeEach(async () => {
        subjectManagerAddress = btcDaiRebalancingManager.address;
      });

      async function subject(): Promise<BTCDAIRebalancingManagerDetails> {
        return await rebalancingManagerAPI.getBTCDAIRebalancingManagerDetailsAsync(
          subjectManagerAddress,
        );
      }

      test('gets the correct core address', async () => {
        const details = await subject();
        expect(details.core).to.equal(core.address);
      });

      test('gets the correct btcPriceFeed address', async () => {
        const details = await subject();
        expect(details.btcPriceFeed).to.equal(btcMedianizer.address);
      });

      test('gets the correct btcAddress address', async () => {
        const details = await subject();
        expect(details.btcAddress).to.equal(wrappedBTC.address);
      });

      test('gets the correct daiAddress address', async () => {
        const details = await subject();
        expect(details.daiAddress).to.equal(dai.address);
      });

      test('gets the correct setTokenFactory address', async () => {
        const details = await subject();
        expect(details.setTokenFactory).to.equal(factory.address);
      });

      test('gets the correct btcMultiplier address', async () => {
        const details = await subject();
        expect(details.btcMultiplier).to.bignumber.equal(btcMultiplier);
      });

      test('gets the correct daiMultiplier address', async () => {
        const details = await subject();
        expect(details.daiMultiplier).to.bignumber.equal(daiMultiplier);
      });

      test('gets the correct auctionLibrary address', async () => {
        const details = await subject();
        expect(details.auctionLibrary).to.equal(constantAuctionPriceCurve.address);
      });

      test('gets the correct auctionTimeToPivot address', async () => {
        const details = await subject();
        expect(details.auctionTimeToPivot).to.bignumber.equal(auctionTimeToPivot);
      });

      test('gets the correct maximumLowerThreshold', async () => {
        const details = await subject();
        expect(details.maximumLowerThreshold).to.bignumber.equal(maximumLowerThreshold);
      });

      test('gets the correct minimumUpperThreshold', async () => {
        const details = await subject();
        expect(details.minimumUpperThreshold).to.bignumber.equal(minimumUpperThreshold);
      });
    });

    describe('proposeAsync', async () => {
      let rebalancingSetToken: RebalancingSetTokenContract;

      let proposalPeriod: BigNumber;
      let btcPrice: BigNumber;
      let daiUnit: BigNumber;

      let initialAllocationToken: SetTokenContract;
      let timeFastForward: BigNumber;
      let nextRebalanceAvailableInSeconds: BigNumber;

      let subjectManagerType: BigNumber;
      let subjectRebalancingSetToken: Address;
      let subjectManagerAddress: Address;
      let subjectCaller: Address;

      const btcdaiManagerWrapper: BTCDAIRebalancingManagerWrapper = new BTCDAIRebalancingManagerWrapper(web3);

      beforeAll(async () => {
        btcPrice = new BigNumber(4082 * 10 ** 18);
        daiUnit = new BigNumber(3000 * 10 ** 10);
      });

      beforeEach(async () => {
        initialAllocationToken = await deploySetTokenAsync(
          web3,
          core,
          factory.address,
          [dai.address, wrappedBTC.address],
          [daiUnit.mul(daiMultiplier), new BigNumber(1).mul(btcMultiplier)],
          new BigNumber(10 ** 10),
        );

        proposalPeriod = ONE_DAY_IN_SECONDS;
        rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
          web3,
          core,
          rebalancingFactory.address,
          btcDaiRebalancingManager.address,
          initialAllocationToken.address,
          proposalPeriod
        );

        timeFastForward = ONE_DAY_IN_SECONDS.add(1);
        await updateMedianizerPriceAsync(
          web3,
          btcMedianizer,
          btcPrice,
          SetTestUtils.generateTimestamp(1000),
        );

        subjectManagerType = ManagerType.BTCDAI;
        subjectManagerAddress = btcDaiRebalancingManager.address;
        subjectRebalancingSetToken = rebalancingSetToken.address;
        subjectCaller = DEFAULT_ACCOUNT;

        const lastRebalancedTimestampSeconds = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
        const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
        nextRebalanceAvailableInSeconds = lastRebalancedTimestampSeconds.plus(rebalanceInterval);
      });

      afterEach(async () => {
        timeKeeper.reset();
      });

      async function subject(): Promise<string> {
        await increaseChainTimeAsync(web3, timeFastForward);
        timeKeeper.freeze(nextRebalanceAvailableInSeconds.toNumber() * 1000);
        return await rebalancingManagerAPI.proposeAsync(
          subjectManagerType,
          subjectManagerAddress,
          subjectRebalancingSetToken,
          { from: subjectCaller },
        );
      }

      test('successfully proposes', async () => {
        await subject();
      });

      describe('when price trigger is not met', async () => {
        beforeAll(async () => {
          btcPrice = new BigNumber(2500 * 10 ** 18);
        });

        afterAll(async () => {
          btcPrice = new BigNumber(4082 * 10 ** 18);
        });

        test('throws', async () => {
          const daiAllocationAmount = new BigNumber(54);
          return expect(subject()).to.be.rejectedWith(
            `Current DAI allocation ${daiAllocationAmount.toString()}% must be outside allocation bounds ` +
            `${maximumLowerThreshold.toString()} and ${minimumUpperThreshold.toString()}.`
          );
        });
      });

      describe('when the RebalancingSet is not in Default state', async () => {
        beforeEach(async () => {
          // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          // Call propose to transition out of Default
          await btcdaiManagerWrapper.propose(btcDaiRebalancingManager.address, rebalancingSetToken.address);
        });

        test('throws', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Rebalancing token at ${rebalancingSetToken.address} must be in Default state to call that function.`
          );
        });
      });

      describe('when the rebalanceInterval has not elapsed', async () => {
        beforeEach(async () => {
          timeFastForward = new BigNumber(1);
          nextRebalanceAvailableInSeconds = nextRebalanceAvailableInSeconds.sub(1);
        });

        test('throws', async () => {
          const lastRebalanceTime = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
          const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
          const nextAvailableRebalance = lastRebalanceTime.add(rebalanceInterval).mul(1000);
          const nextRebalanceFormattedDate = moment(nextAvailableRebalance.toNumber())
          .format('dddd, MMMM Do YYYY, h:mm:ss a');

          return expect(subject()).to.be.rejectedWith(
            `Attempting to rebalance too soon. Rebalancing next ` +
            `available on ${nextRebalanceFormattedDate}`
          );
        });
      });

      describe('when invalid rebalancing set token is passed in', async () => {
        beforeEach(async () => {
          subjectRebalancingSetToken = ACCOUNTS[2].address;
        });

        test('throws', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Contract at ${subjectRebalancingSetToken} is not a valid Set token address.`
          );
        });
      });
    });
  });

  describe('ETHDAIRebalancingManager', async () => {
    let ethDaiRebalancingManager: ETHDaiRebalancingManagerContract;
    let ethMultiplier: BigNumber;
    let daiMultiplier: BigNumber;
    let auctionTimeToPivot: BigNumber;
    let maximumLowerThreshold: BigNumber;
    let minimumUpperThreshold: BigNumber;

    beforeEach(async () => {
      ethMultiplier = new BigNumber(1);
      daiMultiplier = new BigNumber(1);
      auctionTimeToPivot = ONE_DAY_IN_SECONDS;
      maximumLowerThreshold = new BigNumber(47);
      minimumUpperThreshold = new BigNumber(55);

      ethDaiRebalancingManager = await deployEthDaiManagerContractAsync(
        web3,
        core.address,
        ethMedianizer.address,
        dai.address,
        wrappedETH.address,
        factory.address,
        constantAuctionPriceCurve.address,
        auctionTimeToPivot,
        [ethMultiplier, daiMultiplier],
        [maximumLowerThreshold, minimumUpperThreshold]
      );
    });

    describe('getRebalancingManagerDetailsAsync', async () => {
      let subjectManagerAddress: Address;

      beforeEach(async () => {
        subjectManagerAddress = ethDaiRebalancingManager.address;
      });

      async function subject(): Promise<ETHDAIRebalancingManagerDetails> {
        return await rebalancingManagerAPI.getETHDAIRebalancingManagerDetailsAsync(
          subjectManagerAddress,
        );
      }

      test('gets the correct core address', async () => {
        const details = await subject();
        expect(details.core).to.equal(core.address);
      });

      test('gets the correct btcPriceFeed address', async () => {
        const details = await subject();
        expect(details.ethPriceFeed).to.equal(ethMedianizer.address);
      });

      test('gets the correct btcAddress address', async () => {
        const details = await subject();
        expect(details.ethAddress).to.equal(wrappedETH.address);
      });

      test('gets the correct daiAddress address', async () => {
        const details = await subject();
        expect(details.daiAddress).to.equal(dai.address);
      });

      test('gets the correct setTokenFactory address', async () => {
        const details = await subject();
        expect(details.setTokenFactory).to.equal(factory.address);
      });

      test('gets the correct ethMultiplier address', async () => {
        const details = await subject();
        expect(details.ethMultiplier).to.bignumber.equal(ethMultiplier);
      });

      test('gets the correct daiMultiplier address', async () => {
        const details = await subject();
        expect(details.daiMultiplier).to.bignumber.equal(daiMultiplier);
      });

      test('gets the correct auctionLibrary address', async () => {
        const details = await subject();
        expect(details.auctionLibrary).to.equal(constantAuctionPriceCurve.address);
      });

      test('gets the correct auctionTimeToPivot address', async () => {
        const details = await subject();
        expect(details.auctionTimeToPivot).to.bignumber.equal(auctionTimeToPivot);
      });

      test('gets the correct maximumLowerThreshold', async () => {
        const details = await subject();
        expect(details.maximumLowerThreshold).to.bignumber.equal(maximumLowerThreshold);
      });

      test('gets the correct minimumUpperThreshold', async () => {
        const details = await subject();
        expect(details.minimumUpperThreshold).to.bignumber.equal(minimumUpperThreshold);
      });
    });

    describe('proposeAsync', async () => {
      let rebalancingSetToken: RebalancingSetTokenContract;

      let proposalPeriod: BigNumber;
      let ethPrice: BigNumber;
      let daiUnit: BigNumber;

      let initialAllocationToken: SetTokenContract;
      let timeFastForward: BigNumber;
      let nextRebalanceAvailableInSeconds: BigNumber;

      let subjectManagerType: BigNumber;
      let subjectRebalancingSetToken: Address;
      let subjectManagerAddress: Address;
      let subjectCaller: Address;

      const ethdaiManagerWrapper: ETHDAIRebalancingManagerWrapper = new ETHDAIRebalancingManagerWrapper(web3);

      beforeAll(async () => {
        ethPrice = new BigNumber(128 * 10 ** 18);
        daiUnit = new BigNumber(10000);
      });

      beforeEach(async () => {
        initialAllocationToken = await deploySetTokenAsync(
          web3,
          core,
          factory.address,
          [dai.address, wrappedETH.address],
          [daiUnit.mul(daiMultiplier), new BigNumber(100).mul(ethMultiplier)],
          new BigNumber(100),
        );

        proposalPeriod = ONE_DAY_IN_SECONDS;
        rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
          web3,
          core,
          rebalancingFactory.address,
          ethDaiRebalancingManager.address,
          initialAllocationToken.address,
          proposalPeriod
        );

        timeFastForward = ONE_DAY_IN_SECONDS.add(1);
        await updateMedianizerPriceAsync(
          web3,
          ethMedianizer,
          ethPrice,
          SetTestUtils.generateTimestamp(1000),
        );

        subjectManagerType = ManagerType.ETHDAI;
        subjectManagerAddress = ethDaiRebalancingManager.address;
        subjectRebalancingSetToken = rebalancingSetToken.address;
        subjectCaller = DEFAULT_ACCOUNT;

        const lastRebalancedTimestampSeconds = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
        const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
        nextRebalanceAvailableInSeconds = lastRebalancedTimestampSeconds.plus(rebalanceInterval);
      });

      async function subject(): Promise<string> {
        await increaseChainTimeAsync(web3, timeFastForward);
        timeKeeper.freeze(nextRebalanceAvailableInSeconds.toNumber() * 1000);
        return await rebalancingManagerAPI.proposeAsync(
          subjectManagerType,
          subjectManagerAddress,
          subjectRebalancingSetToken,
          { from: subjectCaller },
        );
      }

      test('successfully proposes', async () => {
        await subject();
      });

      describe('when price trigger is not met', async () => {
        beforeAll(async () => {
          ethPrice = new BigNumber(83 * 10 ** 18);
        });

        afterAll(async () => {
          ethPrice = new BigNumber(128 * 10 ** 18);
        });

        test('throws', async () => {
          const daiAllocationAmount = new BigNumber(54);
          return expect(subject()).to.be.rejectedWith(
            `Current DAI allocation ${daiAllocationAmount.toString()}% must be outside allocation bounds ` +
            `${maximumLowerThreshold.toString()} and ${minimumUpperThreshold.toString()}.`
          );
        });
      });

      describe('when the RebalancingSet is not in Default state', async () => {
        beforeEach(async () => {
          // Elapse the rebalance interval
          await increaseChainTimeAsync(web3, ONE_DAY_IN_SECONDS);

          // Call propose to transition out of Default
          await ethdaiManagerWrapper.propose(ethDaiRebalancingManager.address, rebalancingSetToken.address);
        });

        test('throws', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Rebalancing token at ${rebalancingSetToken.address} must be in Default state to call that function.`
          );
        });
      });

      describe('when the rebalanceInterval has not elapsed', async () => {
        beforeEach(async () => {
          timeFastForward = new BigNumber(1);
          nextRebalanceAvailableInSeconds = nextRebalanceAvailableInSeconds.sub(1);
        });

        test('throws', async () => {
          const lastRebalanceTime = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
          const rebalanceInterval = await rebalancingSetToken.rebalanceInterval.callAsync();
          const nextAvailableRebalance = lastRebalanceTime.add(rebalanceInterval).mul(1000);
          const nextRebalanceFormattedDate = moment(nextAvailableRebalance.toNumber())
          .format('dddd, MMMM Do YYYY, h:mm:ss a');

          return expect(subject()).to.be.rejectedWith(
            `Attempting to rebalance too soon. Rebalancing next ` +
            `available on ${nextRebalanceFormattedDate}`
          );
        });
      });

      describe('when invalid rebalancing set token is passed in', async () => {
        beforeEach(async () => {
          subjectRebalancingSetToken = ACCOUNTS[2].address;
        });

        test('throws', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Contract at ${subjectRebalancingSetToken} is not a valid Set token address.`
          );
        });
      });
    });
  });
});
