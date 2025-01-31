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

import * as chai from 'chai';
import * as _ from 'lodash';
import Web3 from 'web3';
import {
  ConstantAuctionPriceCurveContract,
  CoreContract,
  ERC20DetailedContract,
  RebalanceAuctionModuleContract,
  RebalancingSetTokenContract,
  RebalancingSetTokenFactoryContract,
  SetTokenContract,
  SetTokenFactoryContract,
  TransferProxyContract,
  VaultContract,
  WhiteListContract,
} from 'set-protocol-contracts';
import { Web3Utils } from 'set-protocol-utils';

import { RebalancingAPI } from '@src/api';
import { RebalancingSetTokenWrapper, CoreWrapper, ERC20Wrapper, RebalancingAuctionModuleWrapper } from '@src/wrappers';
import {
  DEFAULT_ACCOUNT,
  DEFAULT_AUCTION_PRICE_NUMERATOR,
  DEFAULT_AUCTION_PRICE_DENOMINATOR,
  DEFAULT_REBALANCING_NATURAL_UNIT,
  DEFAULT_UNIT_SHARES,
  ONE_DAY_IN_SECONDS,
  NULL_ADDRESS,
  TX_DEFAULTS,
  UNLIMITED_ALLOWANCE_IN_BASE_UNITS,
} from '@src/constants';
import { ACCOUNTS } from '@src/constants/accounts';
import { BigNumber, ether } from '@src/util';
import { Assertions } from '@src/assertions';
import ChaiSetup from '@test/helpers/chaiSetup';
import {
  addPriceCurveToCoreAsync,
  addWhiteListedTokenAsync,
  approveForTransferAsync,
  constructInflowOutflowAddressesArraysAsync,
  constructInflowOutflowArraysAsync,
  createDefaultRebalancingSetTokenAsync,
  deployBaseContracts,
  deployConstantAuctionPriceCurveAsync,
  deployProtocolViewerAsync,
  deploySetTokensAsync,
  getAuctionSetUpOutputsAsync,
  getExpectedUnitSharesAsync,
  getVaultBalances,
  increaseChainTimeAsync,
  transitionToDrawdownAsync,
  transitionToProposeAsync,
  transitionToRebalanceAsync,
} from '@test/helpers';
import {
  Address,
  BidPlacedEvent,
  RebalancingProgressDetails,
  RebalancingProposalDetails,
  RebalancingSetDetails,
  SetProtocolConfig,
  TokenFlowsDetails,
} from '@src/types/common';

ChaiSetup.configure();
const { expect } = chai;
const timeKeeper = require('timekeeper');
const web3 = new Web3('http://localhost:8545');
const web3Utils = new Web3Utils(web3);
const moment = require('moment');

let currentSnapshotId: number;


describe('RebalancingAPI', () => {
  let nextRebalanceAvailableAtSeconds: number;

  let transferProxy: TransferProxyContract;
  let vault: VaultContract;
  let core: CoreContract;
  let setTokenFactory: SetTokenFactoryContract;
  let rebalancingSetTokenFactory: RebalancingSetTokenFactoryContract;
  let rebalanceAuctionModule: RebalanceAuctionModuleContract;
  let whitelist: WhiteListContract;

  let erc20Wrapper: ERC20Wrapper;
  let rebalancingSetTokenWrapper: RebalancingSetTokenWrapper;
  let rebalancingAuctionModuleWrapper: RebalancingAuctionModuleWrapper;
  let rebalancingAPI: RebalancingAPI;

  beforeEach(async () => {
    currentSnapshotId = await web3Utils.saveTestSnapshot();

    [
      core,
      transferProxy,
      vault,
      setTokenFactory,
      rebalancingSetTokenFactory,
      rebalanceAuctionModule,
      whitelist,
    ] = await deployBaseContracts(web3);

    setTokenFactory = setTokenFactory;

    const coreWrapper = new CoreWrapper(
      web3,
      core.address,
      transferProxy.address,
      vault.address,
    );

    const protocolViewer = await deployProtocolViewerAsync(web3);
    erc20Wrapper = new ERC20Wrapper(web3);
    rebalancingSetTokenWrapper = new RebalancingSetTokenWrapper(web3);
    rebalancingAuctionModuleWrapper = new RebalancingAuctionModuleWrapper(
      web3,
      rebalanceAuctionModule.address,
    );

    const setProtocolConfig: SetProtocolConfig = {
      coreAddress: NULL_ADDRESS,
      transferProxyAddress: NULL_ADDRESS,
      vaultAddress: NULL_ADDRESS,
      setTokenFactoryAddress: NULL_ADDRESS,
      rebalancingSetTokenFactoryAddress: NULL_ADDRESS,
      kyberNetworkWrapperAddress: NULL_ADDRESS,
      rebalanceAuctionModuleAddress: rebalanceAuctionModule.address,
      exchangeIssuanceModuleAddress: NULL_ADDRESS,
      rebalancingSetIssuanceModule: NULL_ADDRESS,
      rebalancingSetExchangeIssuanceModule: NULL_ADDRESS,
      wrappedEtherAddress: NULL_ADDRESS,
      protocolViewerAddress: protocolViewer.address,
    };

    const assertions = new Assertions(web3);
    rebalancingAPI = new RebalancingAPI(web3, assertions, coreWrapper, setProtocolConfig);
  });

  afterEach(async () => {
    timeKeeper.reset();

    await web3Utils.revertToSnapshot(currentSnapshotId);
  });

  describe('proposeAsync', async () => {
    let currentSetToken: SetTokenContract;
    let nextSetToken: SetTokenContract;
    let deployedSetTokenNaturalUnits: BigNumber[] = [];
    let rebalancingSetToken: RebalancingSetTokenContract;
    let rebalanceInterval: BigNumber;
    let managerAddress: Address;

    let subjectRebalancingSetTokenAddress: Address;
    let subjectNextSet: Address;
    let subjectAuctionPriceCurveAddress: Address;
    let subjectAuctionTimeToPivot: BigNumber;
    let subjectAuctionStartPrice: BigNumber;
    let subjectAuctionPivotPrice: BigNumber;
    let subjectCaller: Address;

    beforeEach(async () => {
      const setTokensToDeploy = 2;
      [currentSetToken, nextSetToken] = await deploySetTokensAsync(
        web3,
        core,
        setTokenFactory.address,
        transferProxy.address,
        setTokensToDeploy,
        deployedSetTokenNaturalUnits,
      );

      // Approve proposed Set's components to the whitelist;
      const [proposalComponentOne, proposalComponentTwo] = await nextSetToken.getComponents.callAsync();
      await addWhiteListedTokenAsync(whitelist, proposalComponentOne);
      await addWhiteListedTokenAsync(whitelist, proposalComponentTwo);

      const proposalPeriod = ONE_DAY_IN_SECONDS;
      rebalanceInterval = ONE_DAY_IN_SECONDS;
      managerAddress = ACCOUNTS[1].address;
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      // Deploy price curve used in auction
      const priceCurve = await deployConstantAuctionPriceCurveAsync(
        web3,
        DEFAULT_AUCTION_PRICE_NUMERATOR,
        DEFAULT_AUCTION_PRICE_DENOMINATOR
      );

      addPriceCurveToCoreAsync(
        core,
        priceCurve.address
      );

      // Issue currentSetToken
      const baseSetIssueQuantity = ether(7);
      await core.issue.sendTransactionAsync(currentSetToken.address, baseSetIssueQuantity, TX_DEFAULTS);
      await approveForTransferAsync([currentSetToken], transferProxy.address);

      // Use issued currentSetToken to issue rebalancingSetToken
      const rebalancingSetQuantityToIssue = ether(7);
      await core.issue.sendTransactionAsync(rebalancingSetToken.address, rebalancingSetQuantityToIssue);

      // Fast forward to allow propose to be called
      const lastRebalancedTimestampSeconds = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
      nextRebalanceAvailableAtSeconds = lastRebalancedTimestampSeconds.toNumber() + rebalanceInterval.toNumber();
      timeKeeper.freeze(nextRebalanceAvailableAtSeconds * 1000);
      increaseChainTimeAsync(web3, rebalanceInterval.add(1));

      subjectNextSet = nextSetToken.address;
      subjectAuctionPriceCurveAddress = priceCurve.address;
      subjectAuctionTimeToPivot = new BigNumber(100000);
      subjectAuctionStartPrice = new BigNumber(500);
      subjectAuctionPivotPrice = new BigNumber(1000);
      subjectRebalancingSetTokenAddress = rebalancingSetToken.address;
      subjectCaller = managerAddress;
    });

    afterEach(async () => {
      timeKeeper.reset();
    });

    async function subject(): Promise<string> {
      return await rebalancingAPI.proposeAsync(
        subjectRebalancingSetTokenAddress,
        subjectNextSet,
        subjectAuctionPriceCurveAddress,
        subjectAuctionTimeToPivot,
        subjectAuctionStartPrice,
        subjectAuctionPivotPrice,
        { from: subjectCaller }
      );
    }

    test('it fetches the rebalancing set token properties correctly', async () => {
      await subject();

      const nextSet = await rebalancingSetTokenWrapper.nextSet(subjectRebalancingSetTokenAddress);
      expect(nextSet).to.eql(subjectNextSet);

      const auctionLibrary = await rebalancingSetTokenWrapper.auctionLibrary(subjectRebalancingSetTokenAddress);
      expect(auctionLibrary).to.eql(subjectAuctionPriceCurveAddress);

      const rebalanceState = await rebalancingSetTokenWrapper.rebalanceState(subjectRebalancingSetTokenAddress);
      expect(rebalanceState).to.eql('Proposal');
    });

    describe('when the caller is not the manager', async () => {
      beforeEach(async () => {
        const invalidCallerAddress = ACCOUNTS[0].address;
        subjectCaller = invalidCallerAddress;
      });

      test('throws', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Caller ${subjectCaller} is not the manager of this Rebalancing Set Token.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Rebalance state', async () => {
      beforeEach(async () => {
        // Transition to rebalance state
        await transitionToRebalanceAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          subjectAuctionPriceCurveAddress,
        );
      });

      test('throws', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} is currently in rebalancing state.` +
          ` Issue, Redeem, and propose functionality is not available during this time`
        );
      });
    });

    describe('when the proposed set token is not a valid set', async () => {
      beforeEach(async () => {
        const invalidNextSet = ACCOUNTS[3].address;
        subjectNextSet = invalidNextSet;
      });

      test('throws', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Contract at ${subjectNextSet} is not a valid Set token address.`
        );
      });
    });

    describe('when the proposed set natural unit is not a multiple of the current set', async () => {
      beforeAll(async () => {
        deployedSetTokenNaturalUnits = [ether(.01), ether(.015)];
      });

      afterAll(async () => {
        deployedSetTokenNaturalUnits = [];
      });

      test('throws', async () => {
        return expect(subject()).to.be.rejectedWith(
          `${nextSetToken.address} must be a multiple of ${currentSetToken.address},` +
          ` or vice versa to propose a valid rebalance.`
        );
      });
    });

    describe('when proposeAsync is called before a new rebalance is allowed', async () => {
      beforeEach(async () => {
        timeKeeper.freeze((nextRebalanceAvailableAtSeconds * 1000) - 10);
      });

      test('throws', async () => {
        const nextAvailableRebalance = nextRebalanceAvailableAtSeconds * 1000;
        const nextRebalanceFormattedDate = moment(nextAvailableRebalance)
          .format('dddd, MMMM Do YYYY, h:mm:ss a');
        return expect(subject()).to.be.rejectedWith(
          `Attempting to rebalance too soon. Rebalancing next ` +
          `available on ${nextRebalanceFormattedDate}`
        );
      });
    });

    describe('when proposeAsync is called with an invalid price curve', async () => {
      beforeEach(async () => {
        subjectAuctionPriceCurveAddress = ACCOUNTS[4].address;
      });

      test('throws', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Proposed ${subjectAuctionPriceCurveAddress} is not recognized by Core.`
        );
      });
    });
  });

  describe('startRebalanceAsync', async () => {
    let currentSetToken: SetTokenContract;
    let nextSetToken: SetTokenContract;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let proposalPeriod: BigNumber;
    let managerAddress: Address;
    let priceCurve: ConstantAuctionPriceCurveContract;

    let nextRebalanceAvailableAtSeconds: number;

    let subjectRebalancingSetTokenAddress: Address;
    let subjectCaller: Address;

    beforeEach(async () => {
      const setTokensToDeploy = 2;
      [currentSetToken, nextSetToken] = await deploySetTokensAsync(
        web3,
        core,
        setTokenFactory.address,
        transferProxy.address,
        setTokensToDeploy,
      );

      // Approve proposed Set's components to the whitelist;
      const [proposalComponentOne, proposalComponentTwo] = await nextSetToken.getComponents.callAsync();
      await addWhiteListedTokenAsync(whitelist, proposalComponentOne);
      await addWhiteListedTokenAsync(whitelist, proposalComponentTwo);

      proposalPeriod = ONE_DAY_IN_SECONDS;
      managerAddress = ACCOUNTS[1].address;
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      // Deploy price curve used in auction
      priceCurve = await deployConstantAuctionPriceCurveAsync(
        web3,
        DEFAULT_AUCTION_PRICE_NUMERATOR,
        DEFAULT_AUCTION_PRICE_DENOMINATOR,
      );

      addPriceCurveToCoreAsync(
        core,
        priceCurve.address
      );

      // Issue currentSetToken
      const baseSetIssueQuantity = ether(7);
      await core.issue.sendTransactionAsync(currentSetToken.address, baseSetIssueQuantity, TX_DEFAULTS);
      await approveForTransferAsync([currentSetToken], transferProxy.address);

      // Use issued currentSetToken to issue rebalancingSetToken
      const rebalancingSetQuantityToIssue = ether(7);
      await core.issue.sendTransactionAsync(rebalancingSetToken.address, rebalancingSetQuantityToIssue);

      subjectRebalancingSetTokenAddress = rebalancingSetToken.address;
      subjectCaller = DEFAULT_ACCOUNT;
    });

    async function subject(): Promise<string> {
      return await rebalancingAPI.startRebalanceAsync(
        subjectRebalancingSetTokenAddress,
        { from: subjectCaller }
      );
    }

    describe('when the Rebalancing Set Token is in Default state', async () => {
      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Proposal state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Proposal state', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToProposeAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
        );

        // Fast forward to allow rebalance to be called
        const proposalStartTimeSeconds = await rebalancingSetToken.proposalStartTime.callAsync();
        const fastForwardPeriod = proposalPeriod.toNumber();
        nextRebalanceAvailableAtSeconds = proposalStartTimeSeconds.toNumber() + fastForwardPeriod;
        timeKeeper.freeze(nextRebalanceAvailableAtSeconds * 1000 + 1);
        increaseChainTimeAsync(web3, proposalPeriod.add(1));
      });

      test('it fetches the set token properties correctly', async () => {
        await subject();

        const returnedMinimumBid = await rebalancingSetTokenWrapper.minimumBid(subjectRebalancingSetTokenAddress);
        const returnedRemainingCurrentSets = await rebalancingSetTokenWrapper.remainingCurrentSets(
          subjectRebalancingSetTokenAddress
        );
        const combinedTokenArray = await rebalancingSetTokenWrapper.getCombinedTokenArray(
          subjectRebalancingSetTokenAddress
        );
        const combinedCurrentUnits = await rebalancingSetTokenWrapper.getCombinedCurrentUnits(
          subjectRebalancingSetTokenAddress
        );
        const combinedNextSetUnits = await rebalancingSetTokenWrapper.getCombinedNextSetUnits(
          subjectRebalancingSetTokenAddress
        );
        const returnedRebalanceState = await rebalancingSetTokenWrapper.rebalanceState(
          subjectRebalancingSetTokenAddress
        );

        const auctionSetUpOutputs = await getAuctionSetUpOutputsAsync(
          rebalancingSetToken,
          currentSetToken,
          nextSetToken,
          DEFAULT_AUCTION_PRICE_DENOMINATOR,
        );

        expect(returnedMinimumBid).to.be.bignumber.equal(auctionSetUpOutputs['expectedMinimumBid']);

        expect(returnedRemainingCurrentSets).to.be.bignumber.equal(ether(7));

        const returnedCombinedTokenArray = JSON.stringify(combinedTokenArray);
        const expectedCombinedTokenArray = JSON.stringify(auctionSetUpOutputs['expectedCombinedTokenArray']);
        expect(returnedCombinedTokenArray).to.equal(expectedCombinedTokenArray);

        const returnedCombinedCurrentUnits = JSON.stringify(combinedCurrentUnits);
        const expectedCombinedCurrentUnits = JSON.stringify(auctionSetUpOutputs['expectedCombinedCurrentUnits']);
        expect(returnedCombinedCurrentUnits).to.equal(expectedCombinedCurrentUnits);

        const returnedCombinedNextSetUnits = JSON.stringify(combinedNextSetUnits);
        const expectedCombinedNextSetUnits = JSON.stringify(auctionSetUpOutputs['expectedCombinedNextUnits']);
        expect(returnedCombinedNextSetUnits).to.equal(expectedCombinedNextSetUnits);

        expect(returnedRebalanceState).to.eql('Rebalance');
      });

      describe('when startRebalanceAsync is called before proposal period has elapsed', async () => {
        beforeEach(async () => {
          timeKeeper.freeze((nextRebalanceAvailableAtSeconds * 1000) - 10);
        });

        test('throws', async () => {
          const nextAvailableRebalance = nextRebalanceAvailableAtSeconds * 1000;
          const nextRebalanceFormattedDate = moment(nextAvailableRebalance)
            .format('dddd, MMMM Do YYYY, h:mm:ss a');
          return expect(subject()).to.be.rejectedWith(
            `Attempting to rebalance too soon. Rebalancing next ` +
            `available on ${nextRebalanceFormattedDate}`
          );
        });
      });
    });

    describe('when the Rebalancing Set Token is in Default state', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToRebalanceAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
        );
      });

      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Proposal state to call that function.`
        );
      });
    });
  });

  describe('settleRebalanceAsync', async () => {
    let currentSetToken: SetTokenContract;
    let nextSetToken: SetTokenContract;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let proposalPeriod: BigNumber;
    let managerAddress: Address;
    let priceCurve: ConstantAuctionPriceCurveContract;

    let rebalancingSetQuantityToIssue: BigNumber;

    let subjectRebalancingSetTokenAddress: Address;
    let subjectCaller: Address;

    beforeEach(async () => {
      const setTokensToDeploy = 2;
      [currentSetToken, nextSetToken] = await deploySetTokensAsync(
        web3,
        core,
        setTokenFactory.address,
        transferProxy.address,
        setTokensToDeploy,
      );

      // Approve proposed Set's components to the whitelist;
      const [proposalComponentOne, proposalComponentTwo] = await nextSetToken.getComponents.callAsync();
      await addWhiteListedTokenAsync(whitelist, proposalComponentOne);
      await addWhiteListedTokenAsync(whitelist, proposalComponentTwo);

      proposalPeriod = ONE_DAY_IN_SECONDS;
      managerAddress = ACCOUNTS[1].address;
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      // Issue currentSetToken
      await core.issue.sendTransactionAsync(currentSetToken.address, ether(9), TX_DEFAULTS);
      await approveForTransferAsync([currentSetToken], transferProxy.address);

      // Use issued currentSetToken to issue rebalancingSetToken
      rebalancingSetQuantityToIssue = ether(7);
      await core.issue.sendTransactionAsync(rebalancingSetToken.address, rebalancingSetQuantityToIssue);

      // Deploy price curve used in auction
      priceCurve = await deployConstantAuctionPriceCurveAsync(
        web3,
        DEFAULT_AUCTION_PRICE_NUMERATOR,
        DEFAULT_AUCTION_PRICE_DENOMINATOR
      );

      addPriceCurveToCoreAsync(
        core,
        priceCurve.address
      );

      subjectRebalancingSetTokenAddress = rebalancingSetToken.address;
      subjectCaller = DEFAULT_ACCOUNT;
    });

    async function subject(): Promise<string> {
      return await rebalancingAPI.settleRebalanceAsync(
        subjectRebalancingSetTokenAddress,
        { from: subjectCaller }
      );
    }

    describe('when the Rebalancing Set Token is in Default state', async () => {
      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Rebalance state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Proposal state', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToProposeAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
        );
      });

      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Rebalance state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Rebalance state and enough sets have been rebalanced', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToRebalanceAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
        );

        await rebalanceAuctionModule.bid.sendTransactionAsync(
          rebalancingSetToken.address,
          rebalancingSetQuantityToIssue,
          false,
        );
      });

      test('updates the rebalancing properties correctly', async () => {
        const expectedUnitShares = await getExpectedUnitSharesAsync(
          rebalancingSetToken,
          nextSetToken,
          vault
        );

        await subject();

        const lastBlock = await web3.eth.getBlock('latest');
        const auctionEndTimestamp = new BigNumber(lastBlock.timestamp);

        const returnedRebalanceState = await rebalancingSetTokenWrapper.rebalanceState(
          subjectRebalancingSetTokenAddress
        );
        const returnedCurrentSet = await rebalancingSetTokenWrapper.currentSet(subjectRebalancingSetTokenAddress);
        const returnedUnitShares = await rebalancingSetTokenWrapper.unitShares(subjectRebalancingSetTokenAddress);
        const returnedLastRebalanceTimestamp = await rebalancingSetTokenWrapper.lastRebalanceTimestamp(
          subjectRebalancingSetTokenAddress
        );

        expect(returnedRebalanceState).to.eql('Default');

        expect(returnedCurrentSet).to.eql(nextSetToken.address);

        expect(returnedUnitShares).to.be.bignumber.equal(expectedUnitShares);

        expect(returnedLastRebalanceTimestamp).to.be.bignumber.equal(auctionEndTimestamp);
      });
    });

    describe('when the Rebalancing Set Token is in Rebalance state but\
    not enough sets have been rebalanced', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToRebalanceAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
        );
      });
      it('throw', async () => {
        const [minimumBid, remainingCurrentSets] = await rebalancingSetToken.getBiddingParameters.callAsync();

        return expect(subject()).to.be.rejectedWith(
          `In order to settle rebalance there must be less than current ${minimumBid} sets remaining ` +
            `to be rebalanced. There are currently ${remainingCurrentSets} remaining for rebalance.`
        );
      });
    });
  });

  describe('endFailedAuctionAsync', async () => {
    let currentSetToken: SetTokenContract;
    let nextSetToken: SetTokenContract;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let proposalPeriod: BigNumber;
    let managerAddress: Address;
    let priceCurve: ConstantAuctionPriceCurveContract;

    let rebalancingSetQuantityToIssue: BigNumber;

    let subjectRebalancingSetTokenAddress: Address;
    let subjectCaller: Address;

    let pivotTime: BigNumber;

    beforeEach(async () => {
      const setTokensToDeploy = 2;
      [currentSetToken, nextSetToken] = await deploySetTokensAsync(
        web3,
        core,
        setTokenFactory.address,
        transferProxy.address,
        setTokensToDeploy,
      );

      // Approve proposed Set's components to the whitelist;
      const [proposalComponentOne, proposalComponentTwo] = await nextSetToken.getComponents.callAsync();
      await addWhiteListedTokenAsync(whitelist, proposalComponentOne);
      await addWhiteListedTokenAsync(whitelist, proposalComponentTwo);

      proposalPeriod = ONE_DAY_IN_SECONDS;
      managerAddress = ACCOUNTS[1].address;
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      // Issue currentSetToken
      await core.issue.sendTransactionAsync(currentSetToken.address, ether(9), TX_DEFAULTS);
      await approveForTransferAsync([currentSetToken], transferProxy.address);

      // Use issued currentSetToken to issue rebalancingSetToken
      rebalancingSetQuantityToIssue = ether(7);
      await core.issue.sendTransactionAsync(rebalancingSetToken.address, rebalancingSetQuantityToIssue);

      // Deploy price curve used in auction
      priceCurve = await deployConstantAuctionPriceCurveAsync(
        web3,
        DEFAULT_AUCTION_PRICE_NUMERATOR,
        DEFAULT_AUCTION_PRICE_DENOMINATOR
      );

      addPriceCurveToCoreAsync(
        core,
        priceCurve.address
      );

      subjectRebalancingSetTokenAddress = rebalancingSetToken.address;
      subjectCaller = DEFAULT_ACCOUNT;
    });

    async function subject(): Promise<string> {
      return await rebalancingAPI.endFailedAuctionAsync(
        subjectRebalancingSetTokenAddress,
        { from: subjectCaller }
      );
    }

    describe('when the Rebalancing Set Token is in Default state', async () => {
      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Rebalance state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Proposal state', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToProposeAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
        );
      });

      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Rebalance state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Rebalance state and is before the pivot time', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToRebalanceAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
        );

        pivotTime = new BigNumber(100000);
      });

      it('throw', async () => {
        const lastBlock = await web3.eth.getBlock('latest');
        const auctionStartTimestamp = new BigNumber(lastBlock.timestamp);
        const pivotTimeStart = auctionStartTimestamp.add(pivotTime).toString();
        const pivotTimeFormattedDate = moment(+pivotTimeStart * 1000)
          .format('dddd, MMMM Do YYYY, h:mm:ss a');
        return expect(subject()).to.be.rejectedWith(
          `Pivot time not yet reached. Pivot time starts at ${pivotTimeFormattedDate}`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Rebalance state, is in the pivot time and has 0 bids', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        const setAuctionTimeToPivot = new BigNumber(100000);
        await transitionToRebalanceAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
          setAuctionTimeToPivot,
        );

        // Calculate pivot time start
        const lastBlockStart = await web3.eth.getBlock('latest');
        const auctionStartTimestamp = new BigNumber(lastBlockStart.timestamp);
        const pivotTimeStart = auctionStartTimestamp.add(setAuctionTimeToPivot).toNumber();
        timeKeeper.freeze(pivotTimeStart * 1000 + 1);

        // Fast forward to 1 second after pivot time
        await increaseChainTimeAsync(web3, new BigNumber(pivotTimeStart).add(1).mul(1000));
      });

      afterEach(async () => {
        timeKeeper.reset();
      });

      test('updates the rebalancing properties correctly', async () => {
        const expectedUnitShares = await getExpectedUnitSharesAsync(
          rebalancingSetToken,
          nextSetToken,
          vault
        );

        await subject();

        const lastBlockEnd = await web3.eth.getBlock('latest');
        const auctionEndTimestamp = new BigNumber(lastBlockEnd.timestamp);
        const returnedRebalanceState = await rebalancingSetTokenWrapper.rebalanceState(
          subjectRebalancingSetTokenAddress
        );
        const returnedCurrentSet = await rebalancingSetTokenWrapper.currentSet(subjectRebalancingSetTokenAddress);
        const returnedUnitShares = await rebalancingSetTokenWrapper.unitShares(subjectRebalancingSetTokenAddress);
        const returnedLastRebalanceTimestamp = await rebalancingSetTokenWrapper.lastRebalanceTimestamp(
          subjectRebalancingSetTokenAddress
        );

        expect(returnedRebalanceState).to.eql('Default');

        expect(returnedCurrentSet).to.not.eql(nextSetToken.address);

        expect(returnedUnitShares).to.not.be.bignumber.equal(expectedUnitShares);

        expect(returnedLastRebalanceTimestamp).to.be.bignumber.equal(auctionEndTimestamp);
      });
    });

    describe('when the Rebalancing Set Token is in Rebalance state, in the pivot time and\
    no units are remaining', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        const setAuctionTimeToPivot = new BigNumber(100000);
        await transitionToRebalanceAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
          setAuctionTimeToPivot,
        );

        await rebalanceAuctionModule.bid.sendTransactionAsync(
          rebalancingSetToken.address,
          rebalancingSetQuantityToIssue,
          false,
        );

        // Calculate pivot time start
        const lastBlockStart = await web3.eth.getBlock('latest');
        const auctionStartTimestamp = new BigNumber(lastBlockStart.timestamp);
        const pivotTimeStart = auctionStartTimestamp.add(setAuctionTimeToPivot).toNumber();
        timeKeeper.freeze(pivotTimeStart * 1000 + 1);
      });

      afterEach(async () => {
        timeKeeper.reset();
      });

      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Auction has no remaining bids. Cannot drawdown Set at ${rebalancingSetToken.address}.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Rebalance state, is in the pivot time and has 1 bid', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        const setAuctionTimeToPivot = new BigNumber(100000);
        await transitionToRebalanceAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
          setAuctionTimeToPivot,
        );

        // Calculate pivot time start
        const lastBlockStart = await web3.eth.getBlock('latest');
        const auctionStartTimestamp = new BigNumber(lastBlockStart.timestamp);
        const pivotTimeStart = auctionStartTimestamp.add(setAuctionTimeToPivot).toNumber();
        timeKeeper.freeze(pivotTimeStart * 1000 + 1);

        // Fast forward to 1 second after pivot time
        await increaseChainTimeAsync(web3, new BigNumber(pivotTimeStart).add(1).mul(1000));
      });

      afterEach(async () => {
        timeKeeper.reset();
      });

      test('draws down the ', async () => {
        const expectedUnitShares = await getExpectedUnitSharesAsync(
          rebalancingSetToken,
          nextSetToken,
          vault
        );

        const [minimumBid] = await rebalancingSetToken.getBiddingParameters.callAsync();

        // Bid entire minus minimum amount
        await rebalanceAuctionModule.bid.sendTransactionAsync(
          rebalancingSetToken.address,
          rebalancingSetQuantityToIssue.sub(minimumBid).sub(minimumBid),
          false,
        );

        await subject();

        const lastBlockEnd = await web3.eth.getBlock('latest');
        const auctionEndTimestamp = new BigNumber(lastBlockEnd.timestamp);
        const returnedRebalanceState = await rebalancingSetTokenWrapper.rebalanceState(
          subjectRebalancingSetTokenAddress
        );
        const returnedCurrentSet = await rebalancingSetTokenWrapper.currentSet(subjectRebalancingSetTokenAddress);
        const returnedUnitShares = await rebalancingSetTokenWrapper.unitShares(subjectRebalancingSetTokenAddress);
        const returnedLastRebalanceTimestamp = await rebalancingSetTokenWrapper.lastRebalanceTimestamp(
          subjectRebalancingSetTokenAddress
        );

        expect(returnedRebalanceState).to.eql('Drawdown');

        expect(returnedCurrentSet).to.not.eql(nextSetToken.address);

        expect(returnedUnitShares).to.not.be.bignumber.equal(expectedUnitShares);

        expect(returnedLastRebalanceTimestamp).to.be.bignumber.equal(auctionEndTimestamp);
      });
    });
  });

  describe('bidAsync', async () => {
    let currentSetToken: SetTokenContract;
    let nextSetToken: SetTokenContract;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let proposalPeriod: BigNumber;
    let managerAddress: Address;
    let priceCurve: ConstantAuctionPriceCurveContract;

    let rebalancingSetQuantityToIssue: BigNumber;

    let subjectRebalancingSetTokenAddress: Address;
    let subjectBidQuantity: BigNumber;
    let subjectCaller: Address;
    let subjectShouldWithdraw: boolean;
    let subjectAllowPartialFill: boolean;

    beforeEach(async () => {
      const setTokensToDeploy = 2;
      [currentSetToken, nextSetToken] = await deploySetTokensAsync(
        web3,
        core,
        setTokenFactory.address,
        transferProxy.address,
        setTokensToDeploy,
      );

      // Approve proposed Set's components to the whitelist;
      const [proposalComponentOne, proposalComponentTwo] = await nextSetToken.getComponents.callAsync();
      await addWhiteListedTokenAsync(whitelist, proposalComponentOne);
      await addWhiteListedTokenAsync(whitelist, proposalComponentTwo);

      proposalPeriod = ONE_DAY_IN_SECONDS;
      managerAddress = ACCOUNTS[1].address;
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      // Issue currentSetToken
      await core.issue.sendTransactionAsync(currentSetToken.address, ether(9), TX_DEFAULTS);
      await approveForTransferAsync([currentSetToken], transferProxy.address);

      // Use issued currentSetToken to issue rebalancingSetToken
      rebalancingSetQuantityToIssue = ether(7);
      await core.issue.sendTransactionAsync(rebalancingSetToken.address, rebalancingSetQuantityToIssue);

      // Deploy price curve used in auction
      priceCurve = await deployConstantAuctionPriceCurveAsync(
        web3,
        DEFAULT_AUCTION_PRICE_NUMERATOR,
        DEFAULT_AUCTION_PRICE_DENOMINATOR
      );

      addPriceCurveToCoreAsync(
        core,
        priceCurve.address
      );

      subjectShouldWithdraw = false;
      subjectRebalancingSetTokenAddress = rebalancingSetToken.address;
      subjectBidQuantity = rebalancingSetQuantityToIssue;
      subjectAllowPartialFill = false;
      subjectCaller = DEFAULT_ACCOUNT;
    });

    async function subject(): Promise<string> {
      return await rebalancingAPI.bidAsync(
        subjectRebalancingSetTokenAddress,
        subjectBidQuantity,
        subjectShouldWithdraw,
        subjectAllowPartialFill,
        { from: subjectCaller }
      );
    }

    describe('when the Rebalancing Set Token is in Default state', async () => {
      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Rebalance state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Proposal state', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToProposeAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
        );
      });

      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Rebalance state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Rebalance state', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToRebalanceAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
        );
      });

      test('subtract correct amount from remainingCurrentSets', async () => {
        const [, existingRemainingCurrentSets] = await rebalancingSetToken.getBiddingParameters.callAsync();

        await subject();

        const expectedRemainingCurrentSets = existingRemainingCurrentSets.sub(subjectBidQuantity);
        const [, newRemainingCurrentSets] = await rebalancingSetToken.getBiddingParameters.callAsync();
        expect(newRemainingCurrentSets).to.eql(expectedRemainingCurrentSets);
      });

      test('transfers the correct amount of tokens from the bidder to the rebalancing token in Vault', async () => {
        const expectedTokenFlows = await constructInflowOutflowArraysAsync(
          rebalancingSetToken,
          subjectBidQuantity,
          DEFAULT_AUCTION_PRICE_NUMERATOR,
        );
        const combinedTokenArray = await rebalancingSetToken.getCombinedTokenArray.callAsync();

        const oldSenderBalances = await getVaultBalances(
          vault,
          combinedTokenArray,
          rebalancingSetToken.address
        );

        await subject();

        const newSenderBalances = await getVaultBalances(
          vault,
          combinedTokenArray,
          rebalancingSetToken.address
        );
        const expectedSenderBalances = _.map(oldSenderBalances, (balance, index) =>
          balance.add(expectedTokenFlows['inflow'][index]).sub(expectedTokenFlows['outflow'][index])
        );
        expect(JSON.stringify(newSenderBalances)).to.equal(JSON.stringify(expectedSenderBalances));
      });

      test('transfers the correct amount of tokens to the bidder in the Vault', async () => {
        const expectedTokenFlows = await constructInflowOutflowArraysAsync(
          rebalancingSetToken,
          subjectBidQuantity,
          DEFAULT_AUCTION_PRICE_NUMERATOR,
        );
        const combinedTokenArray = await rebalancingSetToken.getCombinedTokenArray.callAsync();

        const oldReceiverBalances = await getVaultBalances(
          vault,
          combinedTokenArray,
          DEFAULT_ACCOUNT
        );

        await subject();

        const newReceiverBalances = await getVaultBalances(
          vault,
          combinedTokenArray,
          DEFAULT_ACCOUNT
        );
        const expectedReceiverBalances = _.map(oldReceiverBalances, (balance, index) =>
          balance.add(expectedTokenFlows['outflow'][index])
        );

        expect(JSON.stringify(newReceiverBalances)).to.equal(JSON.stringify(expectedReceiverBalances));
      });

      test('transfers and withdraws the correct amount of tokens to the bidder wallet', async () => {
        const expectedTokenFlows = await constructInflowOutflowArraysAsync(
          rebalancingSetToken,
          subjectBidQuantity,
          DEFAULT_AUCTION_PRICE_NUMERATOR,
        );
        const combinedTokenArray = await rebalancingSetToken.getCombinedTokenArray.callAsync();

        const oldReceiverBalances = await Promise.all(
          combinedTokenArray.map(tokenAddress => erc20Wrapper.balanceOf(tokenAddress, DEFAULT_ACCOUNT))
        );

        // Set withdrawal to true
        subjectShouldWithdraw = true;
        await subject();

        const newReceiverBalances = await Promise.all(
          combinedTokenArray.map(tokenAddress => erc20Wrapper.balanceOf(tokenAddress, DEFAULT_ACCOUNT))
        );

        const expectedReceiverBalances = _.map(oldReceiverBalances, (balance, index) =>
          balance.add(expectedTokenFlows['outflow'][index]).sub(expectedTokenFlows['inflow'][index])
        );

        expect(JSON.stringify(newReceiverBalances)).to.equal(JSON.stringify(expectedReceiverBalances));
      });

      describe('and the passed rebalancingSetToken is not tracked by Core', async () => {
        beforeEach(async () => {
          subjectRebalancingSetTokenAddress = ACCOUNTS[5].address;
        });

        it('throw', async () => {
          return expect(subject()).to.be.rejectedWith(
            `Contract at ${subjectRebalancingSetTokenAddress} is not a valid Set token address.`
          );
        });
      });

      describe('and the bid amount is greater than remaining current sets', async () => {
        beforeEach(async () => {
          subjectBidQuantity = ether(10);
        });

        it('throw', async () => {
          const [, remainingCurrentSets] = await rebalancingSetToken.getBiddingParameters.callAsync();

          return expect(subject()).to.be.rejectedWith(
            `The submitted bid quantity, ${subjectBidQuantity}, exceeds the remaining current sets,` +
              ` ${remainingCurrentSets}.`
          );
        });
      });

      describe('and the bid amount is not a multiple of the minimumBid', async () => {
        let minimumBid: BigNumber;

        beforeEach(async () => {
          [minimumBid] = await rebalancingSetToken.getBiddingParameters.callAsync();
          subjectBidQuantity = minimumBid.mul(1.5);
        });

        test('throw', async () => {
          return expect(subject()).to.be.rejectedWith(
            `The submitted bid quantity, ${subjectBidQuantity}, must be a multiple of the minimumBid, ${minimumBid}.`
          );
        });
      });

      describe('and the caller has not approved inflow tokens for transfer', async () => {
        beforeEach(async () => {
          subjectCaller = ACCOUNTS[3].address;
        });

        test('throw', async () => {
          const [inflowArray] = await rebalancingSetToken.getBidPrice.callAsync(subjectBidQuantity);
          const components = await rebalancingSetToken.getCombinedTokenArray.callAsync();

          return expect(subject()).to.be.rejectedWith(
      `
        User: ${subjectCaller} has allowance of 0

        when required allowance is ${inflowArray[2]} at token

        address: ${components[2]} for spender: ${transferProxy.address}.
      `
          );
        });
      });

      describe('and the caller does not have the balance to transfer', async () => {
        beforeEach(async () => {
          subjectCaller = ACCOUNTS[3].address;
          const components = await rebalancingSetToken.getCombinedTokenArray.callAsync();
          const approvalToken: ERC20DetailedContract = await ERC20DetailedContract.at(components[2], web3, {});
          await approvalToken.approve.sendTransactionAsync(
            transferProxy.address,
            UNLIMITED_ALLOWANCE_IN_BASE_UNITS,
            { from: subjectCaller }
          );
        });

        test('throw', async () => {
          const [inflowArray] = await rebalancingSetToken.getBidPrice.callAsync(subjectBidQuantity);
          const components = await rebalancingSetToken.getCombinedTokenArray.callAsync();

          return expect(subject()).to.be.rejectedWith(
      `
        User: ${subjectCaller} has balance of 0

        when required balance is ${inflowArray[2]} at token address ${components[2]}.
      `
          );
        });
      });
    });
  });

  describe('updateManagerAsync', async () => {
    let currentSetToken: SetTokenContract;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let managerAddress: Address;

    let subjectRebalancingSetTokenAddress: Address;
    let subjectNewManager: Address;
    let subjectCaller: Address;

    beforeEach(async () => {
      const setTokensToDeploy = 2;
      [currentSetToken] = await deploySetTokensAsync(
        web3,
        core,
        setTokenFactory.address,
        transferProxy.address,
        setTokensToDeploy,
      );

      const proposalPeriod = ONE_DAY_IN_SECONDS;
      managerAddress = ACCOUNTS[1].address;
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      subjectRebalancingSetTokenAddress = rebalancingSetToken.address;
      subjectNewManager = ACCOUNTS[2].address;
      subjectCaller = managerAddress;
    });

    async function subject(): Promise<string> {
      return await rebalancingAPI.updateManagerAsync(
        subjectRebalancingSetTokenAddress,
        subjectNewManager,
        { from: subjectCaller }
      );
    }

    test('it changes the set manager correctly', async () => {
      await subject();

      const returnedManager = await rebalancingSetTokenWrapper.manager(subjectRebalancingSetTokenAddress);
      expect(returnedManager).to.eql(subjectNewManager);
    });

    describe('when the updateManager is not called by the manager', async () => {
      beforeEach(async () => {
        subjectCaller = ACCOUNTS[2].address;
      });

      test('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Caller ${subjectCaller} is not the manager of this Rebalancing Set Token.`
        );
      });
    });
  });

  describe('redeemFromFailedRebalanceAsync', async () => {
    let currentSetToken: SetTokenContract;
    let nextSetToken: SetTokenContract;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let proposalPeriod: BigNumber;
    let managerAddress: Address;
    let priceCurve: ConstantAuctionPriceCurveContract;

    let rebalancingSetQuantityToIssue: BigNumber;

    let subjectRebalancingSetTokenAddress: Address;
    let subjectCaller: Address;

    beforeEach(async () => {
      const setTokensToDeploy = 2;
      [currentSetToken, nextSetToken] = await deploySetTokensAsync(
        web3,
        core,
        setTokenFactory.address,
        transferProxy.address,
        setTokensToDeploy,
      );

      // Approve proposed Set's components to the whitelist;
      const [proposalComponentOne, proposalComponentTwo] = await nextSetToken.getComponents.callAsync();
      await addWhiteListedTokenAsync(whitelist, proposalComponentOne);
      await addWhiteListedTokenAsync(whitelist, proposalComponentTwo);

      proposalPeriod = ONE_DAY_IN_SECONDS;
      managerAddress = ACCOUNTS[1].address;
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      // Issue currentSetToken
      await core.issue.sendTransactionAsync(currentSetToken.address, ether(9), TX_DEFAULTS);
      await approveForTransferAsync([currentSetToken], transferProxy.address);

      // Use issued currentSetToken to issue rebalancingSetToken
      rebalancingSetQuantityToIssue = ether(7);
      await core.issue.sendTransactionAsync(rebalancingSetToken.address, rebalancingSetQuantityToIssue);

      // Deploy price curve used in auction
      priceCurve = await deployConstantAuctionPriceCurveAsync(
        web3,
        DEFAULT_AUCTION_PRICE_NUMERATOR,
        DEFAULT_AUCTION_PRICE_DENOMINATOR
      );

      addPriceCurveToCoreAsync(
        core,
        priceCurve.address
      );

      subjectRebalancingSetTokenAddress = rebalancingSetToken.address;
      subjectCaller = DEFAULT_ACCOUNT;
    });

    async function subject(): Promise<any> {
      return await rebalancingAPI.redeemFromFailedRebalanceAsync(
        subjectRebalancingSetTokenAddress,
        { from: subjectCaller }
      );
    }

    describe('when the Rebalancing Set Token is in Default state', async () => {
      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Drawdown state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Proposal state', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToProposeAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
        );
      });

      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Drawdown state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Rebalance state', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToRebalanceAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
        );
      });

      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Drawdown state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Drawdown state', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        const setBidAmount = ether(1);

        await transitionToDrawdownAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
          rebalanceAuctionModule,
          setBidAmount,
        );
      });

      it('transfers the collateral to owner after burning the rebalancing Set', async () => {
        const returnedRebalanceState =
          await rebalancingSetTokenWrapper.rebalanceState(subjectRebalancingSetTokenAddress);
        const combinedTokenArray =
          await rebalancingSetToken.getCombinedTokenArray.callAsync();
        const existingCollateralBalances = await getVaultBalances(
          vault,
          combinedTokenArray,
          subjectRebalancingSetTokenAddress
        );

        await subject();

        const expectedRBSetTokenBalance = new BigNumber(0);
        const currentRBSetTokenBalance = await rebalancingSetToken.balanceOf.callAsync(subjectCaller);
        const newOwnerVaultBalances = await getVaultBalances(vault, combinedTokenArray, subjectCaller);

        expect(returnedRebalanceState).to.eql('Drawdown');
        expect(expectedRBSetTokenBalance.toString()).to.eql(currentRBSetTokenBalance.toString());
        expect(JSON.stringify(existingCollateralBalances)).to.be.eql(JSON.stringify(newOwnerVaultBalances));
      });
    });
  });

  describe('getBidPriceAsync', async () => {
    let currentSetToken: SetTokenContract;
    let nextSetToken: SetTokenContract;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let proposalPeriod: BigNumber;
    let managerAddress: Address;
    let priceCurve: ConstantAuctionPriceCurveContract;

    let rebalancingSetQuantityToIssue: BigNumber;

    let subjectRebalancingSetTokenAddress: Address;
    let subjectBidQuantity: BigNumber;

    beforeEach(async () => {
      const setTokensToDeploy = 2;
      [currentSetToken, nextSetToken] = await deploySetTokensAsync(
        web3,
        core,
        setTokenFactory.address,
        transferProxy.address,
        setTokensToDeploy,
      );

      // Approve proposed Set's components to the whitelist;
      const [proposalComponentOne, proposalComponentTwo] = await nextSetToken.getComponents.callAsync();
      await addWhiteListedTokenAsync(whitelist, proposalComponentOne);
      await addWhiteListedTokenAsync(whitelist, proposalComponentTwo);

      proposalPeriod = ONE_DAY_IN_SECONDS;
      managerAddress = ACCOUNTS[1].address;
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      // Issue currentSetToken
      await core.issue.sendTransactionAsync(currentSetToken.address, ether(9), TX_DEFAULTS);
      await approveForTransferAsync([currentSetToken], transferProxy.address);

      // Use issued currentSetToken to issue rebalancingSetToken
      rebalancingSetQuantityToIssue = ether(7);
      await core.issue.sendTransactionAsync(rebalancingSetToken.address, rebalancingSetQuantityToIssue);

      // Deploy price curve used in auction
      priceCurve = await deployConstantAuctionPriceCurveAsync(
        web3,
        DEFAULT_AUCTION_PRICE_NUMERATOR,
        DEFAULT_AUCTION_PRICE_DENOMINATOR
      );

      addPriceCurveToCoreAsync(
        core,
        priceCurve.address
      );

      subjectRebalancingSetTokenAddress = rebalancingSetToken.address;
      subjectBidQuantity = rebalancingSetQuantityToIssue;
    });

    async function subject(): Promise<TokenFlowsDetails> {
      return await rebalancingAPI.getBidPriceAsync(subjectRebalancingSetTokenAddress, subjectBidQuantity);
    }

    describe('when the Rebalancing Set Token is in Default state', async () => {
      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Rebalance state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Proposal state', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToProposeAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress
        );
      });

      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Rebalance state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Rebalance state', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToRebalanceAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress
        );
      });

      test('it fetches the correct token flow details arrays', async () => {
        const returnedTokenFlowDetailsArrays = await subject();

        const expectedTokenAddresses = await rebalancingSetToken.getCombinedTokenArray.callAsync();

        const expectedTokenFlowDetailsArrays = await constructInflowOutflowAddressesArraysAsync(
          rebalancingSetToken,
          subjectBidQuantity,
          DEFAULT_AUCTION_PRICE_NUMERATOR,
          expectedTokenAddresses,
        );

        const returnedInflowArray = JSON.stringify(returnedTokenFlowDetailsArrays['inflow']);
        const expectedInflowArray = JSON.stringify(expectedTokenFlowDetailsArrays['inflow']);
        expect(returnedInflowArray).to.eql(expectedInflowArray);

        const returnedOutflowArray = JSON.stringify(returnedTokenFlowDetailsArrays['outflow']);
        const expectedOutflowArray = JSON.stringify(expectedTokenFlowDetailsArrays['outflow']);
        expect(returnedOutflowArray).to.eql(expectedOutflowArray);
      });

      test('it filters out components with zero units from token flows', async () => {
        const expectedOutflowDetailsZeroCount = 2;
        const expectedInflowDetailsZeroCount = 2;

        const returnedTokenFlowDetailsArrays = await subject();

        // Get Token Flow bid units not filtered for 0s and count of 0 units
        const [
          returnedInflowArray,
          returnedOutflowArray,
        ] = await rebalancingSetToken.getBidPrice.callAsync(subjectBidQuantity);

        const returnedInflowZeroCount = returnedInflowArray.reduce((accumulator, unit) => {
          const bigNumberUnit = new BigNumber(unit);
          if (bigNumberUnit.eq(0)) {
            accumulator++;
          }
          return accumulator;
        }, 0);

        const returnedOutflowZeroCount = returnedOutflowArray.reduce((accumulator, unit) => {
          const bigNumberUnit = new BigNumber(unit);
          if (bigNumberUnit.eq(0)) {
            accumulator++;
          }
          return accumulator;
        }, 0);

        // Get Token Flow Details which should filter for 0s and count of 0 units
        const returnedInflowDetailsZeroCount = returnedTokenFlowDetailsArrays.inflow.reduce((
          accumulator,
          component
          ) => {
          const bigNumberUnit = new BigNumber(component.unit);
          if (bigNumberUnit.eq(0)) {
            accumulator++;
          }
          return accumulator;
        }, 0);

        const returnedOutflowDetailsZeroCount = returnedTokenFlowDetailsArrays.outflow.reduce((
          accumulator,
          component
          ) => {
          const bigNumberUnit = new BigNumber(component.unit);
          if (bigNumberUnit.eq(0)) {
            accumulator++;
          }
          return accumulator;
        }, 0);

        // Ensure there are inflow / outflow components with zero amounts
        expect(returnedInflowZeroCount).to.eql(expectedInflowDetailsZeroCount);
        expect(returnedOutflowZeroCount).to.eql(expectedOutflowDetailsZeroCount);

        // Expect subject to filter out 0s
        expect(returnedInflowDetailsZeroCount).to.eql(0);
        expect(returnedOutflowDetailsZeroCount).to.eql(0);
      });

      describe('and the bid amount is greater than remaining current sets', async () => {
        beforeEach(async () => {
          subjectBidQuantity = ether(10);
        });

        it('throw', async () => {
          const [, remainingCurrentSets] = await rebalancingSetToken.getBiddingParameters.callAsync();

          return expect(subject()).to.be.rejectedWith(
            `The submitted bid quantity, ${subjectBidQuantity}, exceeds the remaining current sets,` +
              ` ${remainingCurrentSets}.`
          );
        });
      });

      describe('and the bid amount is not a multiple of the minimumBid', async () => {
        let minimumBid: BigNumber;

        beforeEach(async () => {
          [minimumBid] = await rebalancingSetToken.getBiddingParameters.callAsync();
          subjectBidQuantity = minimumBid.mul(1.5);
        });

        test('throw', async () => {
          return expect(subject()).to.be.rejectedWith(
            `The submitted bid quantity, ${subjectBidQuantity}, must be a multiple of the minimumBid, ${minimumBid}.`
          );
        });
      });
    });
  });

  describe('getRebalanceStateAsync', async () => {
    let currentSetToken: SetTokenContract;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let proposalPeriod: BigNumber;
    let managerAddress: Address;

    let subjectRebalancingSetTokenAddress: Address;

    beforeEach(async () => {
      const setTokensToDeploy = 1;
      [currentSetToken] = await deploySetTokensAsync(
        web3,
        core,
        setTokenFactory.address,
        transferProxy.address,
        setTokensToDeploy,
      );

      proposalPeriod = ONE_DAY_IN_SECONDS;
      managerAddress = ACCOUNTS[1].address;
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      subjectRebalancingSetTokenAddress = rebalancingSetToken.address;
    });

    async function subject(): Promise<string> {
      return await rebalancingAPI.getRebalanceStateAsync(subjectRebalancingSetTokenAddress);
    }

    it('returns the rebalancing token state', async () => {
      const state = await subject();

      expect(state).to.eql('Default');
    });

    describe('when the rebalancing set address is invalid', async () => {
      beforeEach(async () => {
        subjectRebalancingSetTokenAddress = 'InvalidRebalancingSetTokenAddress';
      });

      test('throws', async () => {
        return expect(subject()).to.be.rejectedWith(
      `
        Expected rebalancingSetTokenAddress to conform to schema /Address.

        Encountered: "InvalidRebalancingSetTokenAddress"

        Validation errors: instance does not match pattern "^0x[0-9a-fA-F]{40}$"
      `
        );
      });
    });
  });

  describe('getRebalancingSetCurrentSetAsync', async () => {
    let currentSetToken: SetTokenContract;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let proposalPeriod: BigNumber;
    let managerAddress: Address;

    let subjectRebalancingSetTokenAddress: Address;

    beforeEach(async () => {
      const setTokensToDeploy = 1;
      [currentSetToken] = await deploySetTokensAsync(
        web3,
        core,
        setTokenFactory.address,
        transferProxy.address,
        setTokensToDeploy,
      );

      proposalPeriod = ONE_DAY_IN_SECONDS;
      managerAddress = ACCOUNTS[1].address;
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      subjectRebalancingSetTokenAddress = rebalancingSetToken.address;
    });

    async function subject(): Promise<string> {
      return await rebalancingAPI.getRebalancingSetCurrentSetAsync(subjectRebalancingSetTokenAddress);
    }

    it('returns the set token address', async () => {
      const currentSetAddress = await subject();

      expect(currentSetAddress).to.eql(currentSetToken.address);
    });
  });

  describe('getBidPlacedEventsAsync', async () => {
    let rebalancingSetToken: RebalancingSetTokenContract;
    let currentSetToken: SetTokenContract;
    let nextSetToken: SetTokenContract;

    let earlyTxnHash: string;
    let earlyBlockNumber: number;

    let bidQuantity: BigNumber;
    let allowPartialFill: boolean;
    let bidderAccount: Address;
    let bid1TxnHash: string;
    let bid2TxnHash: string;

    let subjectFromBlock: number;
    let subjectToBlock: any;
    let subjectRebalancingSetToken: Address;

    beforeEach(async () => {
      const setTokens = await deploySetTokensAsync(
        web3,
        core,
        setTokenFactory.address,
        transferProxy.address,
        2,
      );

      currentSetToken = setTokens[0];
      nextSetToken = setTokens[1];

      const proposalPeriod = ONE_DAY_IN_SECONDS;
      const managerAddress = ACCOUNTS[1].address;
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      // Issue currentSetToken
      earlyTxnHash = await core.issue.sendTransactionAsync(currentSetToken.address, ether(9), TX_DEFAULTS);
      await approveForTransferAsync([currentSetToken], transferProxy.address);

      // Use issued currentSetToken to issue rebalancingSetToken
      const rebalancingSetQuantityToIssue = ether(7);
      await core.issue.sendTransactionAsync(rebalancingSetToken.address, rebalancingSetQuantityToIssue);

      // Approve proposed Set's components to the whitelist;
      const [proposalComponentOne, proposalComponentTwo] = await nextSetToken.getComponents.callAsync();
      await addWhiteListedTokenAsync(whitelist, proposalComponentOne);
      await addWhiteListedTokenAsync(whitelist, proposalComponentTwo);

      // Deploy price curve used in auction
      const priceCurve = await deployConstantAuctionPriceCurveAsync(
        web3,
        DEFAULT_AUCTION_PRICE_NUMERATOR,
        DEFAULT_AUCTION_PRICE_DENOMINATOR
      );

      addPriceCurveToCoreAsync(
        core,
        priceCurve.address
      );

      // Transition to proposal state
      const auctionPriceCurveAddress = priceCurve.address;
      const setAuctionTimeToPivot = new BigNumber(100000);
      const setAuctionStartPrice = new BigNumber(500);
      const setAuctionPivotPrice = new BigNumber(1000);
      await transitionToRebalanceAsync(
        web3,
        rebalancingSetToken,
        managerAddress,
        nextSetToken.address,
        auctionPriceCurveAddress,
        setAuctionTimeToPivot,
        setAuctionStartPrice,
        setAuctionPivotPrice,
      );

      bidQuantity = ether(2);
      allowPartialFill = false;
      bidderAccount = DEFAULT_ACCOUNT;

      bid1TxnHash = await rebalancingAuctionModuleWrapper.bid(
        rebalancingSetToken.address,
        bidQuantity,
        allowPartialFill,
        { from: bidderAccount },
      );

      // Create a second bid transaction
      const rebalancingSetToken2 = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      // Issue currentSetToken
      await core.issue.sendTransactionAsync(currentSetToken.address, ether(9), TX_DEFAULTS);
      await approveForTransferAsync([currentSetToken], transferProxy.address);

      // Use issued currentSetToken to issue rebalancingSetToken
      await core.issue.sendTransactionAsync(rebalancingSetToken2.address, rebalancingSetQuantityToIssue);

      await transitionToRebalanceAsync(
        web3,
        rebalancingSetToken2,
        managerAddress,
        nextSetToken.address,
        auctionPriceCurveAddress,
        setAuctionTimeToPivot,
        setAuctionStartPrice,
        setAuctionPivotPrice,
      );

      bid2TxnHash = await rebalancingAuctionModuleWrapper.bid(
        rebalancingSetToken2.address,
        bidQuantity,
        allowPartialFill,
        { from: bidderAccount },
      );

      const earlyTransaction = await web3.eth.getTransaction(earlyTxnHash);
      earlyBlockNumber = earlyTransaction['blockNumber'];

      const lastBidTransaction = await web3.eth.getTransaction(bid2TxnHash);
      const bidBlockNumber = lastBidTransaction['blockNumber'];

      subjectFromBlock = earlyBlockNumber;
      subjectToBlock = bidBlockNumber;
      subjectRebalancingSetToken = undefined;
    });

    async function subject(): Promise<BidPlacedEvent[]> {
      return await rebalancingAPI.getBidPlacedEventsAsync(
        subjectFromBlock,
        subjectToBlock,
        subjectRebalancingSetToken,
      );
    }

    test('retrieves the right event logs length', async () => {
      const events = await subject();

      expect(events.length).to.equal(2);
    });

    test('retrieves the correct properties', async () => {
      const events = await subject();

      const [firstEvent] = events;

      expect(bid1TxnHash).to.equal(firstEvent.transactionHash);
      expect(rebalancingSetToken.address).to.equal(firstEvent.rebalancingSetToken);
      expect(bidQuantity).to.bignumber.equal(firstEvent.executionQuantity);
    });
  });

  describe('getDetailsAsync', async () => {
    let currentSetToken: SetTokenContract;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let proposalPeriod: BigNumber;
    let managerAddress: Address;
    let priceCurve: ConstantAuctionPriceCurveContract;
    let rebalancingSetQuantityToIssue: BigNumber;

    let subjectRebalancingSetTokenAddress: Address;

    const standardRebalanceInterval = ONE_DAY_IN_SECONDS;

    beforeEach(async () => {
      const setTokensToDeploy = 1;
      [currentSetToken] = await deploySetTokensAsync(
        web3,
        core,
        setTokenFactory.address,
        transferProxy.address,
        setTokensToDeploy,
      );

      proposalPeriod = ONE_DAY_IN_SECONDS;
      managerAddress = ACCOUNTS[1].address;
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      // Issue currentSetToken
      await core.issue.sendTransactionAsync(currentSetToken.address, ether(9), TX_DEFAULTS);
      await approveForTransferAsync([currentSetToken], transferProxy.address);

      // Use issued currentSetToken to issue rebalancingSetToken
      rebalancingSetQuantityToIssue = ether(7);
      await core.issue.sendTransactionAsync(rebalancingSetToken.address, rebalancingSetQuantityToIssue);

      // Deploy price curve used in auction
      priceCurve = await deployConstantAuctionPriceCurveAsync(
        web3,
        DEFAULT_AUCTION_PRICE_NUMERATOR,
        DEFAULT_AUCTION_PRICE_DENOMINATOR
      );

      addPriceCurveToCoreAsync(
        core,
        priceCurve.address
      );

      subjectRebalancingSetTokenAddress = rebalancingSetToken.address;
    });

    async function subject(): Promise<RebalancingSetDetails> {
      return await rebalancingAPI.getDetailsAsync(subjectRebalancingSetTokenAddress);
    }

    it('returns the rebalancing token properties', async () => {
      const details = await subject();

      const lastRebalancedAt = await rebalancingSetToken.lastRebalanceTimestamp.callAsync();
      expect(details.lastRebalancedAt).to.bignumber.equal(lastRebalancedAt);

      expect(details.address).to.eql(subjectRebalancingSetTokenAddress);
      expect(details.factoryAddress).to.eql(rebalancingSetTokenFactory.address);
      expect(details.managerAddress).to.eql(managerAddress);
      expect(details.currentSetAddress).to.eql(currentSetToken.address);
      expect(details.unitShares).to.bignumber.equal(DEFAULT_UNIT_SHARES);
      expect(details.naturalUnit).to.bignumber.equal(DEFAULT_REBALANCING_NATURAL_UNIT);
      expect(details.state).to.eql('Default');
      expect(details.supply).to.bignumber.equal(rebalancingSetQuantityToIssue);
      expect(details.name).to.eql('Rebalancing Set Token');
      expect(details.symbol).to.eql('RBSET');
      expect(details.proposalPeriod).to.bignumber.equal(proposalPeriod);
      expect(details.rebalanceInterval).to.bignumber.equal(standardRebalanceInterval);
    });
  });

  describe('getProposalDetailsAsync', async () => {
    let currentSetToken: SetTokenContract;
    let nextSetToken: SetTokenContract;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let proposalPeriod: BigNumber;
    let managerAddress: Address;
    let priceCurve: ConstantAuctionPriceCurveContract;
    let rebalancingSetQuantityToIssue: BigNumber;

    let subjectRebalancingSetTokenAddress: Address;

    beforeEach(async () => {
      const setTokensToDeploy = 2;
      [currentSetToken, nextSetToken] = await deploySetTokensAsync(
        web3,
        core,
        setTokenFactory.address,
        transferProxy.address,
        setTokensToDeploy,
      );

      // Approve proposed Set's components to the whitelist;
      const [proposalComponentOne, proposalComponentTwo] = await nextSetToken.getComponents.callAsync();
      await addWhiteListedTokenAsync(whitelist, proposalComponentOne);
      await addWhiteListedTokenAsync(whitelist, proposalComponentTwo);

      proposalPeriod = ONE_DAY_IN_SECONDS;
      managerAddress = ACCOUNTS[1].address;
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      // Issue currentSetToken
      await core.issue.sendTransactionAsync(currentSetToken.address, ether(9), TX_DEFAULTS);
      await approveForTransferAsync([currentSetToken], transferProxy.address);

      // Use issued currentSetToken to issue rebalancingSetToken
      rebalancingSetQuantityToIssue = ether(7);
      await core.issue.sendTransactionAsync(rebalancingSetToken.address, rebalancingSetQuantityToIssue);

      // Deploy price curve used in auction
      priceCurve = await deployConstantAuctionPriceCurveAsync(
        web3,
        DEFAULT_AUCTION_PRICE_NUMERATOR,
        DEFAULT_AUCTION_PRICE_DENOMINATOR
      );

      addPriceCurveToCoreAsync(
        core,
        priceCurve.address
      );

      subjectRebalancingSetTokenAddress = rebalancingSetToken.address;
    });

    async function subject(): Promise<RebalancingProposalDetails> {
      return await rebalancingAPI.getProposalDetailsAsync(subjectRebalancingSetTokenAddress);
    }

    describe('when the Rebalancing Set Token is in Default state', async () => {
      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Proposal state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Proposal state', async () => {
      let setAuctionPriceCurveAddress: Address;
      let setAuctionTimeToPivot: BigNumber;
      let setAuctionStartPrice: BigNumber;
      let setAuctionPivotPrice: BigNumber;

      beforeEach(async () => {
        setAuctionPriceCurveAddress = priceCurve.address;
        setAuctionTimeToPivot = new BigNumber(100000);
        setAuctionStartPrice = new BigNumber(500);
        setAuctionPivotPrice = new BigNumber(1000);
        await transitionToProposeAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
          setAuctionTimeToPivot,
          setAuctionStartPrice,
          setAuctionPivotPrice,
        );
      });

      it('returns the proper proposal details', async () => {
        const proposalDetails = await subject();

        expect(proposalDetails.state).to.equal('Proposal');
        expect(proposalDetails.nextSetAddress).eql(nextSetToken.address);
        expect(proposalDetails.pricingLibraryAddress).eql(setAuctionPriceCurveAddress);
        expect(proposalDetails.timeToPivot).to.bignumber.equal(setAuctionTimeToPivot);
        expect(proposalDetails.startingPrice).to.bignumber.equal(setAuctionStartPrice);
        expect(proposalDetails.auctionPivotPrice).to.bignumber.equal(setAuctionPivotPrice);

        const proposedAt = await rebalancingSetToken.proposalStartTime.callAsync();
        expect(proposalDetails.proposalStartTime).to.bignumber.equal(proposedAt);
      });
    });

    describe('when the Rebalancing Set Token is in Rebalance state', async () => {
      let setAuctionPriceCurveAddress: Address;
      let setAuctionTimeToPivot: BigNumber;
      let setAuctionStartPrice: BigNumber;
      let setAuctionPivotPrice: BigNumber;

      beforeEach(async () => {
        setAuctionPriceCurveAddress = priceCurve.address;
        setAuctionTimeToPivot = new BigNumber(100000);
        setAuctionStartPrice = new BigNumber(500);
        setAuctionPivotPrice = new BigNumber(1000);
        await transitionToRebalanceAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress
        );
      });

      it('returns the proper proposal details', async () => {
        const proposalDetails = await subject();

        expect(proposalDetails.state).to.equal('Rebalance');
        expect(proposalDetails.nextSetAddress).eql(nextSetToken.address);
        expect(proposalDetails.pricingLibraryAddress).eql(setAuctionPriceCurveAddress);
        expect(proposalDetails.timeToPivot).to.bignumber.equal(setAuctionTimeToPivot);
        expect(proposalDetails.startingPrice).to.bignumber.equal(setAuctionStartPrice);
        expect(proposalDetails.auctionPivotPrice).to.bignumber.equal(setAuctionPivotPrice);

        const proposedAt = await rebalancingSetToken.proposalStartTime.callAsync();
        expect(proposalDetails.proposalStartTime).to.bignumber.equal(proposedAt);
      });
    });
  });

  describe('getRebalanceDetailsAsync', async () => {
    let currentSetToken: SetTokenContract;
    let nextSetToken: SetTokenContract;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let proposalPeriod: BigNumber;
    let managerAddress: Address;
    let priceCurve: ConstantAuctionPriceCurveContract;
    let rebalancingSetQuantityToIssue: BigNumber;
    let currentSetStartingQuantity: BigNumber;

    let subjectRebalancingSetTokenAddress: Address;

    beforeEach(async () => {
      const setTokensToDeploy = 2;
      [currentSetToken, nextSetToken] = await deploySetTokensAsync(
        web3,
        core,
        setTokenFactory.address,
        transferProxy.address,
        setTokensToDeploy,
      );

      // Approve proposed Set's components to the whitelist;
      const [proposalComponentOne, proposalComponentTwo] = await nextSetToken.getComponents.callAsync();
      await addWhiteListedTokenAsync(whitelist, proposalComponentOne);
      await addWhiteListedTokenAsync(whitelist, proposalComponentTwo);

      proposalPeriod = ONE_DAY_IN_SECONDS;
      managerAddress = ACCOUNTS[1].address;
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      // Issue currentSetToken
      currentSetStartingQuantity = ether(7);
      await core.issue.sendTransactionAsync(currentSetToken.address, currentSetStartingQuantity, TX_DEFAULTS);
      await approveForTransferAsync([currentSetToken], transferProxy.address);

      // Use issued currentSetToken to issue rebalancingSetToken
      rebalancingSetQuantityToIssue = ether(7);
      await core.issue.sendTransactionAsync(rebalancingSetToken.address, rebalancingSetQuantityToIssue);

      // Deploy price curve used in auction
      priceCurve = await deployConstantAuctionPriceCurveAsync(
        web3,
        DEFAULT_AUCTION_PRICE_NUMERATOR,
        DEFAULT_AUCTION_PRICE_DENOMINATOR
      );

      addPriceCurveToCoreAsync(
        core,
        priceCurve.address
      );

      subjectRebalancingSetTokenAddress = rebalancingSetToken.address;
    });

    async function subject(): Promise<RebalancingProgressDetails> {
      return await rebalancingAPI.getRebalanceDetailsAsync(subjectRebalancingSetTokenAddress);
    }

    describe('when the Rebalancing Set Token is in Default state', async () => {
      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Rebalance state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Proposal state', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToProposeAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
        );
      });

      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Rebalance state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Rebalance state', async () => {
      let setAuctionPriceCurveAddress: Address;
      let setAuctionTimeToPivot: BigNumber;
      let setAuctionStartPrice: BigNumber;
      let setAuctionPivotPrice: BigNumber;
      let setCurrentSetStartingQuantity: BigNumber;

      beforeEach(async () => {
        setCurrentSetStartingQuantity = currentSetStartingQuantity;
        setAuctionPriceCurveAddress = priceCurve.address;
        setAuctionTimeToPivot = new BigNumber(100000);
        setAuctionStartPrice = new BigNumber(500);
        setAuctionPivotPrice = new BigNumber(1000);
        await transitionToRebalanceAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
          setAuctionTimeToPivot,
          setAuctionStartPrice,
          setAuctionPivotPrice,
        );
      });

      it('returns the proper rebalancing details', async () => {
        const rebalanceDetails = await subject();

        expect(rebalanceDetails.state).to.equal('Rebalance');

        const [rebalancingStartedAt] = await rebalancingSetToken.getAuctionPriceParameters.callAsync();
        expect(rebalanceDetails.rebalancingStartedAt).to.bignumber.equal(rebalancingStartedAt);

        const [minimumBid, remainingCurrentSets] = await rebalancingSetToken.getBiddingParameters.callAsync();
        expect(rebalanceDetails.remainingCurrentSet).to.bignumber.equal(remainingCurrentSets);
        expect(rebalanceDetails.minimumBid).to.bignumber.equal(minimumBid);

        expect(rebalanceDetails.startingCurrentSetAmount).to.bignumber.equal(setCurrentSetStartingQuantity);
      });
    });
  });

  describe('getRebalancingSetAuctionRemainingCurrentSets', async () => {
    let currentSetToken: SetTokenContract;
    let nextSetToken: SetTokenContract;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let proposalPeriod: BigNumber;
    let managerAddress: Address;
    let priceCurve: ConstantAuctionPriceCurveContract;
    let rebalancingSetQuantityToIssue: BigNumber;
    let currentSetStartingQuantity: BigNumber;

    let subjectRebalancingSetTokenAddress: Address;

    beforeEach(async () => {
      const setTokensToDeploy = 2;
      [currentSetToken, nextSetToken] = await deploySetTokensAsync(
        web3,
        core,
        setTokenFactory.address,
        transferProxy.address,
        setTokensToDeploy,
      );

      // Approve proposed Set's components to the whitelist;
      const [proposalComponentOne, proposalComponentTwo] = await nextSetToken.getComponents.callAsync();
      await addWhiteListedTokenAsync(whitelist, proposalComponentOne);
      await addWhiteListedTokenAsync(whitelist, proposalComponentTwo);

      proposalPeriod = ONE_DAY_IN_SECONDS;
      managerAddress = ACCOUNTS[1].address;
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        managerAddress,
        currentSetToken.address,
        proposalPeriod
      );

      // Issue currentSetToken
      currentSetStartingQuantity = ether(7);
      await core.issue.sendTransactionAsync(currentSetToken.address, currentSetStartingQuantity, TX_DEFAULTS);
      await approveForTransferAsync([currentSetToken], transferProxy.address);

      // Use issued currentSetToken to issue rebalancingSetToken
      rebalancingSetQuantityToIssue = ether(7);
      await core.issue.sendTransactionAsync(rebalancingSetToken.address, rebalancingSetQuantityToIssue);

      // Deploy price curve used in auction
      priceCurve = await deployConstantAuctionPriceCurveAsync(
        web3,
        DEFAULT_AUCTION_PRICE_NUMERATOR,
        DEFAULT_AUCTION_PRICE_DENOMINATOR
      );

      addPriceCurveToCoreAsync(
        core,
        priceCurve.address
      );

      subjectRebalancingSetTokenAddress = rebalancingSetToken.address;
    });

    async function subject(): Promise<BigNumber> {
      return await rebalancingAPI.getRebalancingSetAuctionRemainingCurrentSets(subjectRebalancingSetTokenAddress);
    }

    describe('when the Rebalancing Set Token is in Default state', async () => {
      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Rebalance state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Proposal state', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToProposeAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
        );
      });

      it('throw', async () => {
        return expect(subject()).to.be.rejectedWith(
          `Rebalancing token at ${subjectRebalancingSetTokenAddress} must be in Rebalance state to call that function.`
        );
      });
    });

    describe('when the Rebalancing Set Token is in Rebalance state', async () => {
      beforeEach(async () => {
        const setAuctionPriceCurveAddress = priceCurve.address;
        await transitionToRebalanceAsync(
          web3,
          rebalancingSetToken,
          managerAddress,
          nextSetToken.address,
          setAuctionPriceCurveAddress,
        );
      });

      it('returns the proper rebalancing details', async () => {
        const rebalancingAuctionRemainingCurrentShares = await subject();

        const [, remainingCurrentSets] = await rebalancingSetToken.getBiddingParameters.callAsync();
        expect(rebalancingAuctionRemainingCurrentShares).to.bignumber.equal(remainingCurrentSets);
      });
    });
  });
});
