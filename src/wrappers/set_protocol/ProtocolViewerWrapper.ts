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

import Web3 from 'web3';

import { Address } from '../../types/common';
import { BigNumber } from '../../util';
import { ProtocolContractWrapper } from './ProtocolContractWrapper';

/**
 * @title  ProtocolViewerWrapper
 * @author Set Protocol
 *
 * The ProtocolViewerWrapper handles all functions on the Protocol Viewer smart contract.
 *
 */
export class ProtocolViewerWrapper {
  private web3: Web3;
  private contracts: ProtocolContractWrapper;
  private protocolViewerAddress: Address;

  public constructor(web3: Web3, protocolViewerAddress: Address) {
    this.web3 = web3;
    this.protocolViewerAddress = protocolViewerAddress;
    this.contracts = new ProtocolContractWrapper(this.web3);
  }

  /**
   * Fetches multiple balances for passed in array of ERC20 contract addresses for an owner
   *
   * @param  tokenAddresses    Addresses of ERC20 contracts to check balance for
   * @param  owner             Address to check balance of tokenAddress for
   */
  public async batchFetchBalancesOf(
    tokenAddresses: Address[],
    owner: Address,
  ): Promise<BigNumber[]> {
    const protocolViewerInstance = await this.contracts.loadProtocolViewerContract(
      this.protocolViewerAddress
    );

    return await protocolViewerInstance.batchFetchBalancesOf.callAsync(tokenAddresses, owner);
  }

  /**
   * Fetches multiple supplies for passed in array of ERC20 contract addresses
   *
   * @param  tokenAddresses    Addresses of ERC20 contracts to check supply for
   */
  public async batchFetchSupplies(
    tokenAddresses: Address[],
  ): Promise<BigNumber[]> {
    const protocolViewerInstance = await this.contracts.loadProtocolViewerContract(
      this.protocolViewerAddress
    );

    return await protocolViewerInstance.batchFetchSupplies.callAsync(tokenAddresses);
  }

  /**
   * Fetches all RebalancingSetToken state associated with a rebalance proposal
   *
   * @param  rebalancingSetTokenAddress    RebalancingSetToken contract instance address
   */
  public async fetchRebalanceProposalStateAsync(
    rebalancingSetTokenAddress: Address,
  ): Promise<any> {
    const protocolViewerInstance = await this.contracts.loadProtocolViewerContract(
      this.protocolViewerAddress
    );

    return await protocolViewerInstance.fetchRebalanceProposalStateAsync.callAsync(rebalancingSetTokenAddress);
  }

  /**
   * Fetches all RebalancingSetToken state associated with a new rebalance auction
   *
   * @param  rebalancingSetTokenAddress    RebalancingSetToken contract instance address
   */
  public async fetchRebalanceAuctionStateAsync(
    rebalancingSetTokenAddress: Address,
  ): Promise<any> {
    const protocolViewerInstance = await this.contracts.loadProtocolViewerContract(
      this.protocolViewerAddress
    );

    return await protocolViewerInstance.fetchRebalanceAuctionStateAsync.callAsync(rebalancingSetTokenAddress);
  }
}
