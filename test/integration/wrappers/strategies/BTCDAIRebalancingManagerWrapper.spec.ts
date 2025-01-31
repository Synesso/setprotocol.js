/*
  Copyright 2019 Set Labs Inc.

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
} from 'set-protocol-strategies';

import { DEFAULT_ACCOUNT } from '@src/constants/accounts';
import { BTCDAIRebalancingManagerWrapper } from '@src/wrappers';
import {
  TX_DEFAULTS,
  ONE_DAY_IN_SECONDS,
  DEFAULT_AUCTION_PRICE_NUMERATOR,
  DEFAULT_AUCTION_PRICE_DENOMINATOR,
} from '@src/constants';
import {
  addPriceCurveToCoreAsync,
  addPriceFeedOwnerToMedianizer,
  addWhiteListedTokenAsync,
  approveForTransferAsync,
  createDefaultRebalancingSetTokenAsync,
  deployBaseContracts,
  deployBtcDaiManagerContractAsync,
  deployConstantAuctionPriceCurveAsync,
  deploySetTokenAsync,
  deployMedianizerAsync,
  deployTokensSpecifyingDecimals,
  increaseChainTimeAsync,
  updateMedianizerPriceAsync,
} from '@test/helpers';
import {
  BigNumber,
} from '@src/util';
import { Address } from '@src/types/common';

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


describe('BTCDAIRebalancingManagerWrapper', () => {
  let core: CoreContract;
  let transferProxy: TransferProxyContract;
  let factory: SetTokenFactoryContract;
  let rebalancingFactory: RebalancingSetTokenFactoryContract;
  let constantAuctionPriceCurve: ConstantAuctionPriceCurveContract;
  let btcDaiRebalancingManager: BTCDaiRebalancingManagerContract;
  let btcMedianizer: MedianContract;
  let wrappedBTC: StandardTokenMockContract;
  let dai: StandardTokenMockContract;
  let whitelist: WhiteListContract;

  let btcMultiplier: BigNumber;
  let daiMultiplier: BigNumber;
  let maximumLowerThreshold: BigNumber;
  let minimumUpperThreshold: BigNumber;
  let auctionTimeToPivot: BigNumber;

  let btcDaiManagerWrapper: BTCDAIRebalancingManagerWrapper;

  beforeAll(() => {
    ABIDecoder.addABI(coreContract.abi);
  });

  afterAll(() => {
    ABIDecoder.removeABI(coreContract.abi);
  });

  beforeEach(async () => {
    currentSnapshotId = await web3Utils.saveTestSnapshot();

    [
      core,
      transferProxy, ,
      factory,
      rebalancingFactory, ,
      whitelist,
    ] = await deployBaseContracts(web3);

    btcMedianizer = await deployMedianizerAsync(web3);
    await addPriceFeedOwnerToMedianizer(btcMedianizer, DEFAULT_ACCOUNT);

    [wrappedBTC, dai] = await deployTokensSpecifyingDecimals(2, [8, 18], web3, DEFAULT_ACCOUNT);

    await approveForTransferAsync(
      [wrappedBTC, dai],
      transferProxy.address
    );
    await addWhiteListedTokenAsync(
      whitelist,
      wrappedBTC.address,
    );

    await addWhiteListedTokenAsync(
      whitelist,
      dai.address,
    );

    constantAuctionPriceCurve = await deployConstantAuctionPriceCurveAsync(
      web3,
      DEFAULT_AUCTION_PRICE_NUMERATOR,
      DEFAULT_AUCTION_PRICE_DENOMINATOR,
    );

    await addPriceCurveToCoreAsync(
      core,
      constantAuctionPriceCurve.address,
    );

    btcMultiplier = new BigNumber(1);
    daiMultiplier = new BigNumber(1);

    auctionTimeToPivot = ONE_DAY_IN_SECONDS;

    maximumLowerThreshold = new BigNumber(48);
    minimumUpperThreshold = new BigNumber(52);
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

    btcDaiManagerWrapper = new BTCDAIRebalancingManagerWrapper(
      web3,
    );
  });

  afterEach(async () => {
    await web3Utils.revertToSnapshot(currentSnapshotId);
  });

  describe('core', async () => {
    let subjectManagerAddress: Address;

    beforeEach(async () => {
      subjectManagerAddress = btcDaiRebalancingManager.address;
    });

    async function subject(): Promise<Address> {
      return await btcDaiManagerWrapper.core(
        subjectManagerAddress,
      );
    }

    test('gets the correct core', async () => {
      const address = await subject();
      expect(address).to.equal(core.address);
    });
  });

  describe('btcPriceFeed', async () => {
    let subjectManagerAddress: Address;

    beforeEach(async () => {
      subjectManagerAddress = btcDaiRebalancingManager.address;
    });

    async function subject(): Promise<Address> {
      return await btcDaiManagerWrapper.btcPriceFeed(
        subjectManagerAddress,
      );
    }

    test('gets the correct btcPriceFeed', async () => {
      const address = await subject();
      expect(address).to.equal(btcMedianizer.address);
    });
  });

  describe('btcAddress', async () => {
    let subjectManagerAddress: Address;

    beforeEach(async () => {
      subjectManagerAddress = btcDaiRebalancingManager.address;
    });

    async function subject(): Promise<Address> {
      return await btcDaiManagerWrapper.btcAddress(
        subjectManagerAddress,
      );
    }

    test('gets the correct btcAddress', async () => {
      const address = await subject();
      expect(address).to.equal(wrappedBTC.address);
    });
  });

  describe('daiAddress', async () => {
    let subjectManagerAddress: Address;


    beforeEach(async () => {
      subjectManagerAddress = btcDaiRebalancingManager.address;
    });

    async function subject(): Promise<Address> {
      return await btcDaiManagerWrapper.daiAddress(
        subjectManagerAddress,
      );
    }

    test('gets the correct ethAddress', async () => {
      const address = await subject();
      expect(address).to.equal(dai.address);
    });
  });

  describe('setTokenFactory', async () => {
    let subjectManagerAddress: Address;

    beforeEach(async () => {
      subjectManagerAddress = btcDaiRebalancingManager.address;
    });

    async function subject(): Promise<Address> {
      return await btcDaiManagerWrapper.setTokenFactory(
        subjectManagerAddress,
      );
    }

    test('gets the correct setTokenFactory', async () => {
      const address = await subject();
      expect(address).to.equal(factory.address);
    });
  });

  describe('btcMultiplier', async () => {
    let subjectManagerAddress: Address;

    beforeEach(async () => {
      subjectManagerAddress = btcDaiRebalancingManager.address;
    });

    async function subject(): Promise<BigNumber> {
      return await btcDaiManagerWrapper.btcMultiplier(
        subjectManagerAddress,
      );
    }

    test('gets the correct btcMultiplier', async () => {
      const multiplier = await subject();
      expect(multiplier).to.bignumber.equal(btcMultiplier);
    });
  });

  describe('daiMultiplier', async () => {
    let subjectManagerAddress: Address;

    beforeEach(async () => {
      subjectManagerAddress = btcDaiRebalancingManager.address;
    });

    async function subject(): Promise<BigNumber> {
      return await btcDaiManagerWrapper.daiMultiplier(
        subjectManagerAddress,
      );
    }

    test('gets the correct daiMultiplier', async () => {
      const multiplier = await subject();
      expect(multiplier).to.bignumber.equal(daiMultiplier);
    });
  });

  describe('maximumLowerThreshold', async () => {
    let subjectManagerAddress: Address;

    beforeEach(async () => {
      subjectManagerAddress = btcDaiRebalancingManager.address;
    });

    async function subject(): Promise<BigNumber> {
      return await btcDaiManagerWrapper.maximumLowerThreshold(
        subjectManagerAddress,
      );
    }

    test('gets the correct maximumLowerThreshold', async () => {
      const threshold = await subject();
      expect(threshold).to.bignumber.equal(maximumLowerThreshold);
    });
  });

  describe('minimumUpperThreshold', async () => {
    let subjectManagerAddress: Address;

    beforeEach(async () => {
      subjectManagerAddress = btcDaiRebalancingManager.address;
    });

    async function subject(): Promise<BigNumber> {
      return await btcDaiManagerWrapper.minimumUpperThreshold(
        subjectManagerAddress,
      );
    }

    test('gets the correct minimumUpperThreshold', async () => {
      const threshold = await subject();
      expect(threshold).to.bignumber.equal(minimumUpperThreshold);
    });
  });

  describe('auctionLibrary', async () => {
    let subjectManagerAddress: Address;

    beforeEach(async () => {
      subjectManagerAddress = btcDaiRebalancingManager.address;
    });

    async function subject(): Promise<Address> {
      return await btcDaiManagerWrapper.auctionLibrary(
        subjectManagerAddress,
      );
    }

    test('gets the correct auctionLibrary', async () => {
      const address = await subject();
      expect(address).to.equal(constantAuctionPriceCurve.address);
    });
  });

  describe('auctionTimeToPivot', async () => {
    let subjectManagerAddress: Address;


    beforeEach(async () => {
      subjectManagerAddress = btcDaiRebalancingManager.address;
    });

    async function subject(): Promise<BigNumber> {
      return await btcDaiManagerWrapper.auctionTimeToPivot(
        subjectManagerAddress,
      );
    }

    test('gets the correct auctionTimeToPivot', async () => {
      const address = await subject();
      expect(address).to.bignumber.equal(auctionTimeToPivot);
    });
  });

  describe('propose', async () => {
    let rebalancingSetToken: RebalancingSetTokenContract;

    let proposalPeriod: BigNumber;
    let btcPrice: BigNumber;
    let daiUnit: BigNumber;

    let initialAllocationToken: SetTokenContract;
    let timeFastForward: BigNumber;

    let subjectRebalancingSetToken: Address;
    let subjectManagerAddress: Address;
    let subjectCaller: Address;

    beforeAll(async () => {
      btcPrice = new BigNumber(6000 * 10 ** 18);
      daiUnit = new BigNumber(4082 * 10 ** 10);
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

      subjectManagerAddress = btcDaiRebalancingManager.address;
      subjectRebalancingSetToken = rebalancingSetToken.address;
      subjectCaller = DEFAULT_ACCOUNT;
    });

    async function subject(): Promise<string> {
      await increaseChainTimeAsync(web3, timeFastForward);
      return await btcDaiManagerWrapper.propose(
        subjectManagerAddress,
        subjectRebalancingSetToken,
        { from: subjectCaller },
      );
    }

    test('successfully proposes', async () => {
      await subject();
    });
  });
});
