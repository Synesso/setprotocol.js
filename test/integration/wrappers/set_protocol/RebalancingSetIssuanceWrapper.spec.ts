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

import * as _ from 'lodash';
import * as ABIDecoder from 'abi-decoder';
import * as chai from 'chai';
import * as setProtocolUtils from 'set-protocol-utils';
import Web3 from 'web3';
import { Core } from 'set-protocol-contracts';
import {
  CoreContract,
  RebalancingSetIssuanceModuleContract,
  RebalancingSetTokenContract,
  RebalancingSetTokenFactoryContract,
  SetTokenContract,
  SetTokenFactoryContract,
  StandardTokenMockContract,
  TransferProxyContract,
  VaultContract,
  WethMockContract,
} from 'set-protocol-contracts';

import { RebalancingSetIssuanceModuleWrapper } from '@src/wrappers';
import { DEFAULT_ACCOUNT, ACCOUNTS } from '@src/constants/accounts';
import {
  NULL_ADDRESS,
  TX_DEFAULTS,
  DEFAULT_GAS_LIMIT,
  ZERO,
  ONE_DAY_IN_SECONDS,
  DEFAULT_REBALANCING_NATURAL_UNIT,
  UNLIMITED_ALLOWANCE_IN_BASE_UNITS,
} from '@src/constants';
import {
  addModuleAsync,
  approveForTransferAsync,
  createDefaultRebalancingSetTokenAsync,
  deployBaseContracts,
  deployRebalancingSetIssuanceModuleAsync,
  deploySetTokenAsync,
  deployTokensSpecifyingDecimals,
  deployWethMockAsync,
} from '@test/helpers';
import { BigNumber, ether, getGasUsageInEth } from '@src/util';
import { Address } from '@src/types/common';

const chaiBigNumber = require('chai-bignumber');
chai.use(chaiBigNumber(BigNumber));
const { expect } = chai;
const contract = require('truffle-contract');
const web3 = new Web3('http://localhost:8545');
const { Web3Utils } = setProtocolUtils;
const web3Utils = new Web3Utils(web3);

const coreContract = contract(Core);
coreContract.setProvider(web3.currentProvider);
coreContract.defaults(TX_DEFAULTS);

let currentSnapshotId: number;


describe('RebalancingSetIssuanceModuleWrapper', () => {
  let transferProxy: TransferProxyContract;
  let vault: VaultContract;
  let core: CoreContract;
  let setTokenFactory: SetTokenFactoryContract;
  let rebalancingSetTokenFactory: RebalancingSetTokenFactoryContract;
  let rebalancingSetIssuanceModule: RebalancingSetIssuanceModuleContract;
  let wethMock: WethMockContract;

  let rebalancingSetIssuanceModuleWrapper: RebalancingSetIssuanceModuleWrapper;

  const functionCaller = ACCOUNTS[1].address;

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
      transferProxy,
      vault,
      setTokenFactory,
      rebalancingSetTokenFactory,
    ] = await deployBaseContracts(web3);

    wethMock = await deployWethMockAsync(web3, NULL_ADDRESS, ZERO);
    rebalancingSetIssuanceModule = await deployRebalancingSetIssuanceModuleAsync(
      web3,
      core,
      vault,
      transferProxy,
      wethMock,
    );
    await addModuleAsync(core, rebalancingSetIssuanceModule.address);

    rebalancingSetIssuanceModuleWrapper = new RebalancingSetIssuanceModuleWrapper(
      web3,
      rebalancingSetIssuanceModule.address,
    );
  });

  afterEach(async () => {
    await web3Utils.revertToSnapshot(currentSnapshotId);
  });
  describe('#issueRebalancingSet', async () => {
    let subjectCaller: Address;
    let subjectRebalancingSetAddress: Address;
    let subjectRebalancingSetQuantity: BigNumber;
    let subjectKeepChangeInVault: boolean;

    let baseSetComponent: StandardTokenMockContract;
    let baseSetComponent2: StandardTokenMockContract;
    let baseSetToken: SetTokenContract;
    let baseSetNaturalUnit: BigNumber;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let rebalancingUnitShares: BigNumber;
    let baseSetComponentUnit: BigNumber;
    let baseSetIssueQuantity: BigNumber;

    let customRebalancingUnitShares: BigNumber;
    let customRebalancingSetQuantity: BigNumber;

    beforeEach(async () => {
      subjectCaller = functionCaller;

      [baseSetComponent, baseSetComponent2] = await deployTokensSpecifyingDecimals(2, [18, 18], web3, subjectCaller);

      await approveForTransferAsync(
        [baseSetComponent, baseSetComponent2],
        transferProxy.address,
        subjectCaller,
      );

      // Create the Set (1 component)
      const componentAddresses = [baseSetComponent.address, baseSetComponent2.address];
      baseSetComponentUnit = ether(1);
      const componentUnits = [baseSetComponentUnit, baseSetComponentUnit];
      baseSetNaturalUnit = ether(1);
      baseSetToken = await deploySetTokenAsync(
        web3,
        core,
        setTokenFactory.address,
        componentAddresses,
        componentUnits,
        baseSetNaturalUnit,
      );

      // Create the Rebalancing Set
      rebalancingUnitShares = customRebalancingUnitShares || ether(1);
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        functionCaller,
        baseSetToken.address,
        ONE_DAY_IN_SECONDS,
        rebalancingUnitShares,
      );

      subjectRebalancingSetAddress = rebalancingSetToken.address;

      subjectRebalancingSetQuantity = customRebalancingSetQuantity || new BigNumber(10 ** 18);
      baseSetIssueQuantity =
        subjectRebalancingSetQuantity.mul(rebalancingUnitShares).div(DEFAULT_REBALANCING_NATURAL_UNIT);

      subjectKeepChangeInVault = false;
    });

    async function subject(): Promise<string> {
      return rebalancingSetIssuanceModuleWrapper.issueRebalancingSet(
        subjectRebalancingSetAddress,
        subjectRebalancingSetQuantity,
        subjectKeepChangeInVault,
        {
          from: subjectCaller,
          gas: DEFAULT_GAS_LIMIT,
        },
      );
    }

    it('issues the rebalancing Set', async () => {
      const previousRBSetTokenBalance = await rebalancingSetToken.balanceOf.callAsync(subjectCaller);
      const expectedRBSetTokenBalance = previousRBSetTokenBalance.add(subjectRebalancingSetQuantity);

      await subject();

      const currentRBSetTokenBalance = await rebalancingSetToken.balanceOf.callAsync(subjectCaller);
      expect(expectedRBSetTokenBalance).to.bignumber.equal(currentRBSetTokenBalance);
    });


    it('uses the correct amount of component tokens', async () => {
      const previousComponentBalance = await baseSetComponent.balanceOf.callAsync(subjectCaller);
      const expectedComponentUsed = baseSetIssueQuantity.mul(baseSetComponentUnit).div(baseSetNaturalUnit);

      const expectedComponentBalance = previousComponentBalance.sub(expectedComponentUsed);

      await subject();

      const componentBalance = await baseSetComponent.balanceOf.callAsync(subjectCaller);
      expect(expectedComponentBalance).to.bignumber.equal(componentBalance);
    });

    it('uses the correct amount of component 2 tokens', async () => {
      const previousComponentBalance = await baseSetComponent2.balanceOf.callAsync(subjectCaller);
      const expectedComponentUsed = baseSetIssueQuantity.mul(baseSetComponentUnit).div(baseSetNaturalUnit);

      const expectedComponentBalance = previousComponentBalance.sub(expectedComponentUsed);

      await subject();

      const componentBalance = await baseSetComponent2.balanceOf.callAsync(subjectCaller);
      expect(expectedComponentBalance).to.bignumber.equal(componentBalance);
    });

    describe('when the rebalancing Set quantiy results in base Set change', async () => {
      beforeAll(async () => {
        customRebalancingSetQuantity = new BigNumber(1.5).mul(10 ** 11);
        customRebalancingUnitShares = new BigNumber(10 ** 17);
      });

      afterAll(async () => {
        customRebalancingSetQuantity = undefined;
        customRebalancingUnitShares = undefined;
      });

      it('returns the correct quantity of base Set change', async () => {
        await subject();

        const baseSetChange = baseSetIssueQuantity.mod(baseSetNaturalUnit);

        const baseSetBalance = await baseSetToken.balanceOf.callAsync(subjectCaller);
        expect(baseSetBalance).to.bignumber.equal(baseSetChange);
      });

      describe('when keepChangeInVault is true', async () => {
        beforeEach(async () => {
          subjectKeepChangeInVault = true;
        });

        it('returns the correct quantity of base Set change in the Vault', async () => {
          await subject();

          const baseSetChange = baseSetIssueQuantity.mod(baseSetNaturalUnit);

          const baseSetBalance = await vault.getOwnerBalance.callAsync(
            baseSetToken.address,
            subjectCaller,
          );
          expect(baseSetBalance).to.bignumber.equal(baseSetChange);
        });
      });
    });
  });

  describe('#issueRebalancingSetWrappingEther', async () => {
    let subjectCaller: Address;
    let subjectRebalancingSetAddress: Address;
    let subjectRebalancingSetQuantity: BigNumber;
    let subjectKeepChangeInVault: boolean;
    let subjectWethQuantity: BigNumber;

    let baseSetWethComponent: WethMockContract;
    let baseSetComponent: StandardTokenMockContract;
    let baseSetToken: SetTokenContract;
    let baseSetNaturalUnit: BigNumber;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let rebalancingUnitShares: BigNumber;
    let baseSetComponentUnit: BigNumber;
    let baseSetIssueQuantity: BigNumber;

    let customBaseIssueQuantity: BigNumber;
    let customRebalancingUnitShares: BigNumber;
    let customRebalancingSetQuantity: BigNumber;

    beforeEach(async () => {
      subjectCaller = functionCaller;

      [baseSetComponent] = await deployTokensSpecifyingDecimals(1, [18], web3, subjectCaller);

      await approveForTransferAsync(
        [baseSetComponent],
        transferProxy.address,
        subjectCaller,
      );

      baseSetWethComponent = wethMock;

      baseSetWethComponent.approve.sendTransactionAsync(
        transferProxy.address,
        UNLIMITED_ALLOWANCE_IN_BASE_UNITS,
        { from: subjectCaller, gas: DEFAULT_GAS_LIMIT }
      );

      // Create the Set (2 component)
      const componentAddresses = [baseSetWethComponent.address, baseSetComponent.address];
      baseSetComponentUnit = ether(1);
      const componentUnits = [baseSetComponentUnit, baseSetComponentUnit];
      baseSetNaturalUnit = ether(1);
      baseSetToken = await deploySetTokenAsync(
        web3,
        core,
        setTokenFactory.address,
        componentAddresses,
        componentUnits,
        baseSetNaturalUnit,
      );

      // Create the Rebalancing Set
      rebalancingUnitShares = customRebalancingUnitShares || ether(1);
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        functionCaller,
        baseSetToken.address,
        ONE_DAY_IN_SECONDS,
        rebalancingUnitShares,
      );

      subjectRebalancingSetAddress = rebalancingSetToken.address;

      subjectRebalancingSetQuantity = customRebalancingSetQuantity || new BigNumber(10 ** 11);
      baseSetIssueQuantity = customBaseIssueQuantity ||
        subjectRebalancingSetQuantity.mul(rebalancingUnitShares).div(DEFAULT_REBALANCING_NATURAL_UNIT);

      subjectWethQuantity = baseSetIssueQuantity.mul(baseSetComponentUnit).div(baseSetNaturalUnit);

      subjectKeepChangeInVault = false;
    });

    async function subject(): Promise<string> {
      return rebalancingSetIssuanceModuleWrapper.issueRebalancingSetWrappingEther(
        subjectRebalancingSetAddress,
        subjectRebalancingSetQuantity,
        subjectKeepChangeInVault,
        {
          from: subjectCaller,
          gas: DEFAULT_GAS_LIMIT,
          value: subjectWethQuantity.toNumber(),
        },
      );
    }

    it('issues the rebalancing Set', async () => {
      const previousRBSetTokenBalance = await rebalancingSetToken.balanceOf.callAsync(subjectCaller);
      const expectedRBSetTokenBalance = previousRBSetTokenBalance.add(subjectRebalancingSetQuantity);

      await subject();

      const currentRBSetTokenBalance = await rebalancingSetToken.balanceOf.callAsync(subjectCaller);
      expect(expectedRBSetTokenBalance).to.bignumber.equal(currentRBSetTokenBalance);
    });


    it('uses the correct amount of component tokens', async () => {
      const previousComponentBalance = await baseSetComponent.balanceOf.callAsync(subjectCaller);
      const expectedComponentUsed = baseSetIssueQuantity.mul(baseSetComponentUnit).div(baseSetNaturalUnit);

      const expectedComponentBalance = previousComponentBalance.sub(expectedComponentUsed);

      await subject();

      const componentBalance = await baseSetComponent.balanceOf.callAsync(subjectCaller);
      expect(expectedComponentBalance).to.bignumber.equal(componentBalance);
    });

    it('uses the correct amount of ETH from the caller', async () => {
      const previousEthBalance: BigNumber = new BigNumber(await web3.eth.getBalance(subjectCaller));

      const txHash = await subject();
      const totalGasInEth = await getGasUsageInEth(web3, txHash);
      const expectedEthBalance = previousEthBalance
                                  .sub(subjectWethQuantity)
                                  .sub(totalGasInEth);

      const ethBalance = new BigNumber(await web3.eth.getBalance(subjectCaller));
      expect(ethBalance).to.bignumber.equal(expectedEthBalance);
    });

    describe('when the rebalancing Set quantiy results in base Set change', async () => {
      beforeAll(async () => {
        customRebalancingSetQuantity = new BigNumber(1.5).mul(10 ** 11);
        customRebalancingUnitShares = new BigNumber(10 ** 17);
        customBaseIssueQuantity = ether(2);
      });

      afterAll(async () => {
        customRebalancingSetQuantity = undefined;
        customRebalancingUnitShares = undefined;
        customBaseIssueQuantity = undefined;
      });

      it('returns the correct quantity of base Set change', async () => {
        await subject();

        const expectedBaseSetChange = new BigNumber(5).mul(10 ** 17);

        const baseSetBalance = await baseSetToken.balanceOf.callAsync(subjectCaller);
        expect(baseSetBalance).to.bignumber.equal(expectedBaseSetChange);
      });

      describe('when keepChangeInVault is true', async () => {
        beforeEach(async () => {
          subjectKeepChangeInVault = true;
        });

        it('returns the correct quantity of base Set change in the Vault', async () => {
          await subject();

          const expectedBaseSetChange = new BigNumber(5).mul(10 ** 17);

          const baseSetBalance = await vault.getOwnerBalance.callAsync(
            baseSetToken.address,
            subjectCaller,
          );
          expect(baseSetBalance).to.bignumber.equal(expectedBaseSetChange);
        });
      });
    });
  });

  describe('#redeemRebalancingSet', async () => {
    let subjectCaller: Address;
    let subjectRebalancingSetAddress: Address;
    let subjectRebalancingSetQuantity: BigNumber;
    let subjectKeepChangeInVault: boolean;

    let baseSetIssueQuantity: BigNumber;
    let baseSetComponentUnit: BigNumber;

    let baseSetComponent: StandardTokenMockContract;
    let baseSetComponent2: StandardTokenMockContract;
    let baseSetToken: SetTokenContract;
    let baseSetNaturalUnit: BigNumber;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let rebalancingUnitShares: BigNumber;

    let customBaseIssueQuantity: BigNumber;
    let customRebalancingUnitShares: BigNumber;
    let customRedeemQuantity: BigNumber;
    let customRebalancingSetIssueQuantity: BigNumber;
    let customBaseComponentUnit: BigNumber;

    beforeEach(async () => {
      subjectCaller = functionCaller;

      [baseSetComponent, baseSetComponent2] = await deployTokensSpecifyingDecimals(2, [18, 18], web3, DEFAULT_ACCOUNT);

      await approveForTransferAsync(
        [baseSetComponent, baseSetComponent2],
        transferProxy.address,
        DEFAULT_ACCOUNT,
      );

      // Create the Set (2 component)
      const componentAddresses = [baseSetComponent.address, baseSetComponent2.address];
      baseSetComponentUnit = customBaseComponentUnit || ether(1);
      const componentUnits = [baseSetComponentUnit, baseSetComponentUnit];
      baseSetNaturalUnit = ether(1);
      baseSetToken = await deploySetTokenAsync(
        web3,
        core,
        setTokenFactory.address,
        componentAddresses,
        componentUnits,
        baseSetNaturalUnit,
      );
      await approveForTransferAsync(
        [baseSetToken],
        transferProxy.address,
        DEFAULT_ACCOUNT,
      );

      // Create the Rebalancing Set
      rebalancingUnitShares = customRebalancingUnitShares || ether(1);
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        functionCaller,
        baseSetToken.address,
        ONE_DAY_IN_SECONDS,
        rebalancingUnitShares,
      );

      subjectRebalancingSetAddress = rebalancingSetToken.address;

      subjectRebalancingSetQuantity = customRedeemQuantity || new BigNumber(10 ** 11);
      baseSetIssueQuantity = customBaseIssueQuantity ||
        subjectRebalancingSetQuantity.mul(rebalancingUnitShares).div(DEFAULT_REBALANCING_NATURAL_UNIT);

      await core.issue.sendTransactionAsync(
        baseSetToken.address,
        baseSetIssueQuantity,
        { from: DEFAULT_ACCOUNT, gas: DEFAULT_GAS_LIMIT }
      );

      const rebalancingSetIssueQuantity = customRebalancingSetIssueQuantity || subjectRebalancingSetQuantity;

      // Issue the rebalancing Set Token
      await core.issueTo.sendTransactionAsync(
        functionCaller,
        rebalancingSetToken.address,
        rebalancingSetIssueQuantity,
        { from: DEFAULT_ACCOUNT, gas: DEFAULT_GAS_LIMIT }
      );

      subjectKeepChangeInVault = false;
    });

    async function subject(): Promise<string> {
      return rebalancingSetIssuanceModuleWrapper.redeemRebalancingSet(
        subjectRebalancingSetAddress,
        subjectRebalancingSetQuantity,
        subjectKeepChangeInVault,
        {
          from: subjectCaller,
          gas: DEFAULT_GAS_LIMIT,
        },
      );
    }

    afterEach(async () => {
      customRedeemQuantity = undefined;
      customRebalancingUnitShares = undefined;
      customBaseIssueQuantity = undefined;
      customRebalancingSetIssueQuantity = undefined;
      customBaseComponentUnit = undefined;
    });

    it('redeems the rebalancing Set', async () => {
      const previousRBSetTokenBalance = await rebalancingSetToken.balanceOf.callAsync(subjectCaller);
      const expectedRBSetTokenBalance = previousRBSetTokenBalance.sub(subjectRebalancingSetQuantity);

      await subject();

      const currentRBSetTokenBalance = await rebalancingSetToken.balanceOf.callAsync(subjectCaller);
      expect(expectedRBSetTokenBalance).to.bignumber.equal(currentRBSetTokenBalance);
    });

    it('redeems the base Set', async () => {
      await subject();

      const currentSaseSetTokenBalance = await baseSetToken.balanceOf.callAsync(subjectCaller);
      expect(currentSaseSetTokenBalance).to.bignumber.equal(ZERO);
    });

    it('attributes the base Set components to the caller', async () => {
      await subject();

      const expectedBaseComponentBalance = baseSetIssueQuantity.mul(baseSetComponentUnit).div(baseSetNaturalUnit);

      const baseSetComponentBalance = await baseSetComponent.balanceOf.callAsync(subjectCaller);
      expect(baseSetComponentBalance).to.bignumber.equal(expectedBaseComponentBalance);
    });

    it('attributes the base Set components 2 to the caller', async () => {
      await subject();

      const expectedBaseComponentBalance = baseSetIssueQuantity.mul(baseSetComponentUnit).div(baseSetNaturalUnit);

      const baseSetComponentBalance = await baseSetComponent2.balanceOf.callAsync(subjectCaller);
      expect(baseSetComponentBalance).to.bignumber.equal(expectedBaseComponentBalance);
    });

    describe('when the redeem quantity results in excess base Set', async () => {
      describe('when keep change in vault is false', async () => {
        beforeAll(async () => {
          customRebalancingUnitShares  = new BigNumber(10 ** 17);
          customRedeemQuantity = new BigNumber(1.5).mul(10 ** 11);
          customBaseIssueQuantity = ether(2);
          customRebalancingSetIssueQuantity = new BigNumber(2).mul(10 ** 11);
        });

        afterAll(async () => {
          customRebalancingUnitShares = undefined;
          customRedeemQuantity = undefined;
          customBaseIssueQuantity = undefined;
          customRebalancingSetIssueQuantity = undefined;
        });

        // It sends the change to the user
        it('sends the correct base set quantity to the user', async () => {
          await subject();

          const expectedBalance = customRedeemQuantity
                                    .mul(rebalancingUnitShares)
                                    .div(DEFAULT_REBALANCING_NATURAL_UNIT)
                                    .mod(baseSetNaturalUnit);

          const currentBaseSetBalance = await baseSetToken.balanceOf.callAsync(subjectCaller);
          expect(currentBaseSetBalance).to.bignumber.equal(expectedBalance);
        });
      });

      describe('when keep change in vault is true', async () => {
        beforeEach(async () => {
          customRebalancingUnitShares  = new BigNumber(10 ** 17);
          customRedeemQuantity = new BigNumber(1.5).mul(10 ** 11);
          customBaseIssueQuantity = ether(2);
          customRebalancingSetIssueQuantity = new BigNumber(2).mul(10 ** 11);
        });

        afterEach(async () => {
          customRebalancingUnitShares = undefined;
          customRedeemQuantity = undefined;
          customBaseIssueQuantity = undefined;
          customRebalancingSetIssueQuantity = undefined;
        });

        beforeEach(async () => {
          subjectKeepChangeInVault = true;
        });

        it('sends the correct base set quantity to the user in the vault', async () => {
          await subject();

          const expectedBalance = customRedeemQuantity
                                  .mul(rebalancingUnitShares)
                                  .div(DEFAULT_REBALANCING_NATURAL_UNIT)
                                  .mod(baseSetNaturalUnit);
          const currentBaseSetBalance = await vault.getOwnerBalance.callAsync(
            baseSetToken.address,
            subjectCaller,
          );
          expect(currentBaseSetBalance).to.bignumber.equal(expectedBalance);
        });
      });
    });
  });

  describe('#redeemRebalancingSetUnwrappingEther', async () => {
    let subjectCaller: Address;
    let subjectRebalancingSetAddress: Address;
    let subjectRebalancingSetQuantity: BigNumber;
    let subjectKeepChangeInVault: boolean;

    let baseSetIssueQuantity: BigNumber;
    let baseSetComponentUnit: BigNumber;

    let baseSetWethComponent: WethMockContract;
    let baseSetComponent: StandardTokenMockContract;
    let baseSetToken: SetTokenContract;
    let baseSetNaturalUnit: BigNumber;
    let rebalancingSetToken: RebalancingSetTokenContract;
    let rebalancingUnitShares: BigNumber;

    let customBaseIssueQuantity: BigNumber;
    let customRebalancingUnitShares: BigNumber;
    let customRedeemQuantity: BigNumber;
    let customRebalancingSetIssueQuantity: BigNumber;

    let wethRequiredToMintSet: BigNumber;
    let baseComponentQuantity: BigNumber;

    beforeEach(async () => {
      subjectCaller = functionCaller;

      [baseSetComponent] = await deployTokensSpecifyingDecimals(1, [18], web3, DEFAULT_ACCOUNT);

      await approveForTransferAsync(
        [baseSetComponent],
        transferProxy.address,
        DEFAULT_ACCOUNT,
      );

      baseSetWethComponent = wethMock;

      baseSetWethComponent.approve.sendTransactionAsync(
        transferProxy.address,
        UNLIMITED_ALLOWANCE_IN_BASE_UNITS,
        { from: DEFAULT_ACCOUNT, gas: DEFAULT_GAS_LIMIT }
      );

      // Create the Set (2 component)
      const componentAddresses = [baseSetWethComponent.address, baseSetComponent.address];
      baseSetComponentUnit = ether(1);
      const componentUnits = [baseSetComponentUnit, baseSetComponentUnit];
      baseSetNaturalUnit = ether(1);
      baseSetToken = await deploySetTokenAsync(
        web3,
        core,
        setTokenFactory.address,
        componentAddresses,
        componentUnits,
        baseSetNaturalUnit,
      );
      await approveForTransferAsync([baseSetToken], transferProxy.address, DEFAULT_ACCOUNT);

      // Create the Rebalancing Set
      rebalancingUnitShares = customRebalancingUnitShares || ether(1);
      rebalancingSetToken = await createDefaultRebalancingSetTokenAsync(
        web3,
        core,
        rebalancingSetTokenFactory.address,
        DEFAULT_ACCOUNT,
        baseSetToken.address,
        ONE_DAY_IN_SECONDS,
        rebalancingUnitShares,
      );

      subjectRebalancingSetAddress = rebalancingSetToken.address;

      subjectRebalancingSetQuantity = customRedeemQuantity || new BigNumber(10 ** 11);
      baseSetIssueQuantity = customBaseIssueQuantity ||
        subjectRebalancingSetQuantity.mul(rebalancingUnitShares).div(DEFAULT_REBALANCING_NATURAL_UNIT);

      baseComponentQuantity = baseSetIssueQuantity.mul(baseSetComponentUnit).div(baseSetNaturalUnit);

      // Wrap WETH
      wethRequiredToMintSet = baseSetIssueQuantity.mul(baseSetComponentUnit).div(baseSetNaturalUnit);
      await wethMock.deposit.sendTransactionAsync(
        { from: DEFAULT_ACCOUNT, gas: DEFAULT_GAS_LIMIT, value: wethRequiredToMintSet.toString() }
      );

      await core.issue.sendTransactionAsync(
        baseSetToken.address,
        baseSetIssueQuantity,
        { from: DEFAULT_ACCOUNT, gas: DEFAULT_GAS_LIMIT }
      );

      const rebalancingSetIssueQuantity = customRebalancingSetIssueQuantity || subjectRebalancingSetQuantity;

      // Issue the rebalancing Set Token
      await core.issueTo.sendTransactionAsync(
        functionCaller,
        rebalancingSetToken.address,
        rebalancingSetIssueQuantity,
        { from: DEFAULT_ACCOUNT, gas: DEFAULT_GAS_LIMIT }
      );

      subjectKeepChangeInVault = false;
    });

    async function subject(): Promise<string> {
      return rebalancingSetIssuanceModuleWrapper.redeemRebalancingSetUnwrappingEther(
        subjectRebalancingSetAddress,
        subjectRebalancingSetQuantity,
        subjectKeepChangeInVault,
        {
          from: subjectCaller,
          gas: DEFAULT_GAS_LIMIT,
        },
      );
    }

    afterEach(async () => {
      customRebalancingUnitShares = undefined;
      customBaseIssueQuantity = undefined;
      customRedeemQuantity = undefined;
      customRebalancingSetIssueQuantity = undefined;
    });

    it('redeems the rebalancing Set', async () => {
      const previousRBSetTokenBalance = await rebalancingSetToken.balanceOf.callAsync(subjectCaller);
      const expectedRBSetTokenBalance = previousRBSetTokenBalance.sub(subjectRebalancingSetQuantity);

      await subject();

      const currentRBSetTokenBalance = await rebalancingSetToken.balanceOf.callAsync(subjectCaller);
      expect(expectedRBSetTokenBalance).to.bignumber.equal(currentRBSetTokenBalance);
    });

    it('redeems the base Set', async () => {
      await subject();

      const currentSaseSetTokenBalance = await baseSetToken.balanceOf.callAsync(subjectCaller);
      expect(currentSaseSetTokenBalance).to.bignumber.equal(ZERO);
    });

    it('attributes the correct amount of ETH to the caller', async () => {
      const previousEthBalance: BigNumber = new BigNumber(await web3.eth.getBalance(subjectCaller));

      const txHash = await subject();
      const totalGasInEth = await getGasUsageInEth(web3, txHash);
      const expectedEthBalance = previousEthBalance
                                  .add(wethRequiredToMintSet)
                                  .sub(totalGasInEth);

      const ethBalance = new BigNumber(await web3.eth.getBalance(subjectCaller));
      expect(ethBalance).to.bignumber.equal(expectedEthBalance);
    });

    it('attributes the base Set component to the caller', async () => {
      await subject();

      const baseSetComponentBalance = await baseSetComponent.balanceOf.callAsync(subjectCaller);
      expect(baseSetComponentBalance).to.bignumber.equal(baseComponentQuantity);
    });

    describe('when the redeem quantity results in excess base Set', async () => {
      describe('when keep change in vault is false', async () => {
        beforeAll(async () => {
          customRebalancingUnitShares  = new BigNumber(10 ** 17);
          customRedeemQuantity = new BigNumber(1.5).mul(10 ** 11);
          customBaseIssueQuantity = ether(2);
          customRebalancingSetIssueQuantity = new BigNumber(2).mul(10 ** 11);
        });

        afterAll(async () => {
          customRebalancingUnitShares = undefined;
          customRedeemQuantity = undefined;
          customBaseIssueQuantity = undefined;
          customRebalancingSetIssueQuantity = undefined;
        });

        // It sends the change to the user
        it('sends the correct base set quantity to the user', async () => {
          await subject();

          const expectedBalance = customRedeemQuantity
                                    .mul(rebalancingUnitShares)
                                    .div(DEFAULT_REBALANCING_NATURAL_UNIT)
                                    .mod(baseSetNaturalUnit);

          const currentBaseSetBalance = await baseSetToken.balanceOf.callAsync(subjectCaller);
          expect(currentBaseSetBalance).to.bignumber.equal(expectedBalance);
        });
      });

      describe('when keep change in vault is true', async () => {
        beforeAll(async () => {
          customRebalancingUnitShares  = new BigNumber(10 ** 17);
          customRedeemQuantity = new BigNumber(1.5).mul(10 ** 11);
          customBaseIssueQuantity = ether(2);
          customRebalancingSetIssueQuantity = new BigNumber(2).mul(10 ** 11);
        });

        afterAll(async () => {
          customRebalancingUnitShares = undefined;
          customRedeemQuantity = undefined;
          customBaseIssueQuantity = undefined;
          customRebalancingSetIssueQuantity = undefined;
        });

        beforeEach(async () => {
          subjectKeepChangeInVault = true;
        });

        it('sends the correct base set quantity to the user in the vault', async () => {
          await subject();

          const expectedBalance = customRedeemQuantity
                                  .mul(rebalancingUnitShares)
                                  .div(DEFAULT_REBALANCING_NATURAL_UNIT)
                                  .mod(baseSetNaturalUnit);
          const currentBaseSetBalance = await vault.getOwnerBalance.callAsync(
            baseSetToken.address,
            subjectCaller,
          );
          expect(currentBaseSetBalance).to.bignumber.equal(expectedBalance);
        });
      });
    });
  });

});
