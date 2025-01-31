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

import * as _ from 'lodash';
import Web3 from 'web3';

import { Assertions } from '../assertions';
import { ERC20Wrapper, ProtocolViewerWrapper } from '../wrappers';
import { BigNumber } from '../util';
import { Address, SetProtocolConfig, Tx } from '../types/common';

/**
 * @title ERC20API
 * @author Set Protocol
 *
 * A library for interacting with ERC20 compliant token contracts
 */
export class ERC20API {
  private assert: Assertions;
  private erc20Wrapper: ERC20Wrapper;
  private protocolViewerWrapper: ProtocolViewerWrapper;

  /**
   * Instantiates a new IssuanceAPI instance that contains methods for transferring balances in the vault
   *
   * @param web3          Web3.js Provider instance you would like the SetProtocol.js library to use for interacting
   *                        with the Ethereum network
   * @param assertions    An instance of the Assertion library
   * @param config        Configuration object conforming to SetProtocolConfig with Set Protocol's contract addresses
   */
  constructor(web3: Web3, assertions: Assertions, config: SetProtocolConfig) {
    this.assert = assertions;

    this.erc20Wrapper = new ERC20Wrapper(web3);
    this.protocolViewerWrapper = new ProtocolViewerWrapper(web3, config.protocolViewerAddress);
  }

  /**
   * Fetches the user's ERC20 token balance
   *
   * @param  tokenAddress    Address of the ERC20 token
   * @param  userAddress     Wallet address of the user
   * @return                 Balance of the ERC20 token
   */
  public async getBalanceOfAsync(tokenAddress: Address, userAddress: Address): Promise<BigNumber> {
    this.assertGetBalanceOf(tokenAddress, userAddress);

    return await this.erc20Wrapper.balanceOf(tokenAddress, userAddress);
  }

  /**
   * Fetches an addresses balance of multiple ERC20 tokens
   *
   * @param  tokenAddresses    Address of the ERC20 token
   * @param  userAddress       Wallet address of the user
   * @return                   Balance of the ERC20 token
   */
  public async getBalancesOfAsync(tokenAddresses: Address[], userAddress: Address): Promise<BigNumber[]> {
    this.assertGetBalancesOf(tokenAddresses, userAddress);

    return await this.protocolViewerWrapper.batchFetchBalancesOf(tokenAddresses, userAddress);
  }

  /**
   * Fetches the name of the ERC20 token
   *
   * @param  tokenAddress    Address of the ERC20 token
   * @return                 Name of the ERC20 token
   */
  public async getNameAsync(tokenAddress: Address): Promise<string> {
    this.assert.schema.isValidAddress('tokenAddress', tokenAddress);

    return await this.erc20Wrapper.name(tokenAddress);
  }

  /**
   * Fetches the symbol of the ERC20 token
   *
   * @param  tokenAddress    Address of the ERC20 token
   * @return                 Symbol of the ERC20 token
   */
  public async getSymbolAsync(tokenAddress: Address): Promise<string> {
    this.assert.schema.isValidAddress('tokenAddress', tokenAddress);

    return await this.erc20Wrapper.symbol(tokenAddress);
  }

  /**
   * Fetches the total supply of the ERC20 token
   *
   * @param  tokenAddress    Address of the ERC20 token
   * @return                 Total supply of the ERC20 token
   */
  public async getTotalSupplyAsync(tokenAddress: Address): Promise<BigNumber> {
    this.assert.schema.isValidAddress('tokenAddress', tokenAddress);

    return await this.erc20Wrapper.totalSupply(tokenAddress);
  }

  /**
   * Fetches the total supply of multiple ERC20 token contracts, returned in the
   * order the addresses were submitted to the request
   *
   * @param  tokenAddresses    Addresses of the ERC20 tokens
   * @return                   Total supply property of multiple ERC20 contracts
   */
  public async getTotalSuppliesAsync(tokenAddresses: Address[]): Promise<BigNumber[]> {
    this.assertGetTotalSuppliesAsync(tokenAddresses);

    return await this.protocolViewerWrapper.batchFetchSupplies(tokenAddresses);
  }

  /**
   * Fetches the decimals of the ERC20 token
   *
   * @param  tokenAddress    Address of the ERC20 token
   * @return                 Decimals of the ERC20 token
   */
  public async getDecimalsAsync(tokenAddress: Address): Promise<BigNumber> {
    this.assert.schema.isValidAddress('tokenAddress', tokenAddress);

    return await this.erc20Wrapper.decimals(tokenAddress);
  }

  /**
   * Fetches the allowance of the spender for the token by the owner
   *
   * @param  tokenAddress      Address of the token
   * @param  ownerAddress      Address of the owner
   * @param  spenderAddress    Address of the spender
   * @return                   Allowance of the spender
   */
  public async getAllowanceAsync(
    tokenAddress: Address,
    ownerAddress: Address,
    spenderAddress: Address
  ): Promise<BigNumber> {
    this.assertGetAllowance(tokenAddress, ownerAddress, spenderAddress);

    return await this.erc20Wrapper.allowance(tokenAddress, ownerAddress, spenderAddress);
  }

  /**
   * Transfer balance denominated in the specified ERC20 token to another address
   *
   * @param  tokenAddress    Address of the token to transfer
   * @param  to              Address of the receiver
   * @param  value           Amount being transferred
   * @param  txOpts          Transaction options object conforming to `Tx` with signer, gas, and gasPrice data
   * @return                 Transaction hash
   */
  public async transferAsync(
    tokenAddress: Address,
    to: Address,
    value: BigNumber,
    txOpts: Tx,
  ): Promise<string> {
    this.assertTransfer(tokenAddress, to);

    return await this.erc20Wrapper.transfer(tokenAddress, to, value, txOpts);
  }

  /**
   * Transfer balance denominated in the specified ERC20 token on behalf of the owner. Caller
   * must have sufficient allowance from owner in order to complete transfer. Use `approveAsync`
   * to grant allowance
   *
   * @param  tokenAddress    Address of the token to transfer
   * @param  from            Token owner
   * @param  to              Address of the receiver
   * @param  value           Amount to be transferred
   * @param  txOpts          Transaction options object conforming to `Tx` with signer, gas, and gasPrice data
   * @return                 Transaction hash
   */
  public async transferFromAsync(
    tokenAddress: Address,
    from: Address,
    to: Address,
    value: BigNumber,
    txOpts: Tx,
  ): Promise<string> {
    this.assertTransferFrom(tokenAddress, from, to);

    return await this.erc20Wrapper.transferFrom(tokenAddress, from, to, value, txOpts);
  }

  /**
   * Approves the specified amount of allowance to the spender on behalf of the signer
   *
   * @param  tokenAddress      Address of the token being used
   * @param  spenderAddress    Address to approve allowance to
   * @param  value             Amount of allowance to grant
   * @param  txOpts            Transaction options object conforming to `Tx` with signer, gas, and gasPrice data
   * @return                   Transaction hash
   */
  public async approveAsync(
    tokenAddress: Address,
    spenderAddress: Address,
    value: BigNumber,
    txOpts: Tx,
  ): Promise<string> {
    this.assertApprove(tokenAddress, spenderAddress);

    return await this.erc20Wrapper.approve(tokenAddress, spenderAddress, value, txOpts);
  }

  /* ============ Private Assertions ============ */

  private assertGetBalanceOf(tokenAddress: Address, userAddress: Address) {
    this.assert.schema.isValidAddress('tokenAddress', tokenAddress);
    this.assert.schema.isValidAddress('userAddress', userAddress);
  }

  private assertGetBalancesOf(tokenAddresses: Address[], userAddress: Address) {
    this.assert.schema.isValidAddress('userAddress', userAddress);
    tokenAddresses.forEach(tokenAddress => {
      this.assert.schema.isValidAddress('tokenAddress', tokenAddress);
    });
  }

  private assertGetAllowance(tokenAddress: Address, ownerAddress: Address, spenderAddress: Address) {
    this.assert.schema.isValidAddress('tokenAddress', tokenAddress);
    this.assert.schema.isValidAddress('ownerAddress', ownerAddress);
    this.assert.schema.isValidAddress('spenderAddress', spenderAddress);
  }

  private assertTransfer(tokenAddress: Address, to: Address) {
    this.assert.schema.isValidAddress('tokenAddress', tokenAddress);
    this.assert.schema.isValidAddress('to', to);
  }

  private assertTransferFrom(tokenAddress: Address, from: Address, to: Address) {
    this.assert.schema.isValidAddress('tokenAddress', tokenAddress);
    this.assert.schema.isValidAddress('from', from);
    this.assert.schema.isValidAddress('to', to);
  }

  private assertApprove(tokenAddress: Address, spenderAddress: Address) {
    this.assert.schema.isValidAddress('tokenAddress', tokenAddress);
    this.assert.schema.isValidAddress('spenderAddress', spenderAddress);
  }

  private assertGetTotalSuppliesAsync(tokenAddresses: Address[]) {
    tokenAddresses.forEach(tokenAddress => {
      this.assert.schema.isValidAddress('tokenAddress', tokenAddress);
    });
  }
}
