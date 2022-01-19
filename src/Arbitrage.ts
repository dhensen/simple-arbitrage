import * as _ from "lodash";
import { BigNumber, Contract, Wallet } from "ethers";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { WETH_ADDRESS } from "./addresses";
import { EthMarket } from "./EthMarket";
import { ETHER, bigNumberToDecimal } from "./utils";
import { Block } from "@ethersproject/abstract-provider";
import { formatEther } from "ethers/lib/utils";

export interface CrossedMarketDetails {
  profit: BigNumber;
  volume: BigNumber;
  tokenAddress: string;
  buyFromMarket: EthMarket;
  sellToMarket: EthMarket;
}

export type MarketsByToken = { [tokenAddress: string]: Array<EthMarket> };

// TODO: implement binary search (assuming linear/exponential global maximum profitability)
const TEST_VOLUMES = [
  ETHER.div(100),
  ETHER.div(10),
  ETHER.div(6),
  ETHER.div(4),
  ETHER.div(2),
  ETHER.div(1),
  ETHER.mul(2),
  ETHER.mul(5),
  ETHER.mul(10),
];

export function getBestCrossedMarket(
  crossedMarkets: Array<EthMarket>[],
  tokenAddress: string
): CrossedMarketDetails | undefined {
  let bestCrossedMarket: CrossedMarketDetails | undefined = undefined;
  for (const crossedMarket of crossedMarkets) {
    const sellToMarket = crossedMarket[0];
    const buyFromMarket = crossedMarket[1];
    for (const size of TEST_VOLUMES) {
      const tokensOutFromBuyingSize = buyFromMarket.getTokensOut(
        WETH_ADDRESS,
        tokenAddress,
        size
      );
      const proceedsFromSellingTokens = sellToMarket.getTokensOut(
        tokenAddress,
        WETH_ADDRESS,
        tokensOutFromBuyingSize
      );
      const profit = proceedsFromSellingTokens.sub(size);
      if (
        bestCrossedMarket !== undefined &&
        profit.lt(bestCrossedMarket.profit)
      ) {
        // If the next size up lost value, meet halfway. TODO: replace with real binary search
        const trySize = size.add(bestCrossedMarket.volume).div(2);
        const tryTokensOutFromBuyingSize = buyFromMarket.getTokensOut(
          WETH_ADDRESS,
          tokenAddress,
          trySize
        );
        const tryProceedsFromSellingTokens = sellToMarket.getTokensOut(
          tokenAddress,
          WETH_ADDRESS,
          tryTokensOutFromBuyingSize
        );
        const tryProfit = tryProceedsFromSellingTokens.sub(trySize);
        if (tryProfit.gt(bestCrossedMarket.profit)) {
          bestCrossedMarket = {
            volume: trySize,
            profit: tryProfit,
            tokenAddress,
            sellToMarket,
            buyFromMarket,
          };
        }
        break;
      }
      bestCrossedMarket = {
        volume: size,
        profit: profit,
        tokenAddress,
        sellToMarket,
        buyFromMarket,
      };
    }
  }
  return bestCrossedMarket;
}

export class Arbitrage {
  private executorWallet: Wallet;
  private flashbotsProvider: FlashbotsBundleProvider;
  private bundleExecutorContract: Contract;

  constructor(
    executorWallet: Wallet,
    flashbotsProvider: FlashbotsBundleProvider,
    bundleExecutorContract: Contract
  ) {
    this.executorWallet = executorWallet;
    this.flashbotsProvider = flashbotsProvider;
    this.bundleExecutorContract = bundleExecutorContract;
  }

  static printCrossedMarket(crossedMarket: CrossedMarketDetails): void {
    const buyTokens = crossedMarket.buyFromMarket.tokens;
    const sellTokens = crossedMarket.sellToMarket.tokens;
    console.log(
      `Profit: ${bigNumberToDecimal(
        crossedMarket.profit
      )} Volume: ${bigNumberToDecimal(crossedMarket.volume)}\n` +
        `${crossedMarket.buyFromMarket.protocol} (${crossedMarket.buyFromMarket.marketAddress})\n` +
        `  ${buyTokens[0]} => ${buyTokens[1]}\n` +
        `${crossedMarket.sellToMarket.protocol} (${crossedMarket.sellToMarket.marketAddress})\n` +
        `  ${sellTokens[0]} => ${sellTokens[1]}\n` +
        `\n`
    );
  }

  async evaluateMarkets(
    marketsByToken: MarketsByToken
  ): Promise<Array<CrossedMarketDetails>> {
    const bestCrossedMarkets = new Array<CrossedMarketDetails>();

    for (const tokenAddress in marketsByToken) {
      const markets = marketsByToken[tokenAddress];
      const pricedMarkets = _.map(markets, (ethMarket: EthMarket) => {
        return {
          ethMarket: ethMarket,
          buyTokenPrice: ethMarket.getTokensIn(
            tokenAddress,
            WETH_ADDRESS,
            ETHER.div(100)
          ),
          sellTokenPrice: ethMarket.getTokensOut(
            WETH_ADDRESS,
            tokenAddress,
            ETHER.div(100)
          ),
        };
      });

      const crossedMarkets = new Array<Array<EthMarket>>();
      for (const pricedMarket of pricedMarkets) {
        _.forEach(pricedMarkets, (pm) => {
          if (pm.sellTokenPrice.gt(pricedMarket.buyTokenPrice)) {
            crossedMarkets.push([pricedMarket.ethMarket, pm.ethMarket]);
          }
        });
      }

      const bestCrossedMarket = getBestCrossedMarket(
        crossedMarkets,
        tokenAddress
      );
      if (
        bestCrossedMarket !== undefined &&
        bestCrossedMarket.profit.gt(ETHER.div(1000))
      ) {
        bestCrossedMarkets.push(bestCrossedMarket);
      }
    }
    bestCrossedMarkets.sort((a, b) =>
      a.profit.lt(b.profit) ? 1 : a.profit.gt(b.profit) ? -1 : 0
    );
    return bestCrossedMarkets;
  }

  // TODO: take more than 1
  async takeCrossedMarkets(
    bestCrossedMarkets: CrossedMarketDetails[],
    blockNumber: number,
    minerRewardPercentage: number,
    block: Block,
    chainId: number,
    gasPrice: BigNumber
  ): Promise<void> {
    for (const bestCrossedMarket of bestCrossedMarkets) {
      console.log(
        "Send this much WETH",
        formatEther(bestCrossedMarket.volume),
        "get this much profit",
        formatEther(bestCrossedMarket.profit)
      );
      const buyCalls =
        await bestCrossedMarket.buyFromMarket.sellTokensToNextMarket(
          WETH_ADDRESS,
          bestCrossedMarket.volume,
          bestCrossedMarket.sellToMarket
        );
      const inter = bestCrossedMarket.buyFromMarket.getTokensOut(
        WETH_ADDRESS,
        bestCrossedMarket.tokenAddress,
        bestCrossedMarket.volume
      );
      const sellCallData = await bestCrossedMarket.sellToMarket.sellTokens(
        bestCrossedMarket.tokenAddress,
        inter,
        this.bundleExecutorContract.address
      );

      const targets: Array<string> = [
        ...buyCalls.targets,
        bestCrossedMarket.sellToMarket.marketAddress,
      ];
      const payloads: Array<string> = [...buyCalls.data, sellCallData];
      console.log({ targets, payloads });
      const minerReward = bestCrossedMarket.profit
        .mul(minerRewardPercentage)
        .div(100);
      const GWEI = BigNumber.from(10).pow(9);
      const PRIORITY_FEE = GWEI.mul(3);
      const LEGACY_GAS_PRICE = GWEI.mul(12);
      const BLOCKS_IN_THE_FUTURE = 2;

      if (block.baseFeePerGas == null) {
        console.warn("This chain is not EIP-1559 enabled. Stopping");
        return;
      }

      const maxBaseFeeInFutureBlock =
        FlashbotsBundleProvider.getMaxBaseFeeInFutureBlock(
          block.baseFeePerGas,
          BLOCKS_IN_THE_FUTURE
        );
      const transaction =
        await this.bundleExecutorContract.populateTransaction.uniswapWeth(
          bestCrossedMarket.volume,
          minerReward,
          targets,
          payloads,
          {
            maxFeePerGas: PRIORITY_FEE.add(maxBaseFeeInFutureBlock),
            maxPriorityFeePerGas: PRIORITY_FEE,
            gasLimit: 60000,
            type: 2,
          }
        );
      const gasWasteTransaction = {
        to: this.executorWallet.address,
        type: 2,
        maxFeePerGas: PRIORITY_FEE.add(maxBaseFeeInFutureBlock),
        maxPriorityFeePerGas: PRIORITY_FEE,
        gasLimit: 21000,
        data: "0x",
        chainId,
      };

      try {
        const estimateGas =
          await this.bundleExecutorContract.provider.estimateGas({
            ...transaction,
            from: this.executorWallet.address,
            chainId,
          });
        if (estimateGas.gt(1400000)) {
          console.log(
            "EstimateGas succeeded, but suspiciously large: " +
              estimateGas.toString()
          );
          continue;
        }
        transaction.gasLimit = estimateGas.mul(2);
      } catch (e) {
        console.error(e);
        console.warn(
          `Estimate gas failure for ${JSON.stringify(
            bestCrossedMarket,
            null,
            4
          )}`
        );

        // there is an estimate gas failure, I dont know why, but just set gas limit to 80K and not continue.
        transaction.gasLimit = BigNumber.from(80000);
        // continue;
      }
      const bundledTransactions = [
        {
          signer: this.executorWallet,
          transaction: { ...transaction, chainId },
        },
        {
          signer: this.executorWallet,
          transaction: gasWasteTransaction,
        },
      ];
      console.log(bundledTransactions);
      const signedBundle = await this.flashbotsProvider.signBundle(
        bundledTransactions
      );
      //
      const simulation = await this.flashbotsProvider.simulate(
        signedBundle,
        blockNumber + 1
      );
      if ("error" in simulation) {
        console.log(
          `Simulation Error on token ${bestCrossedMarket.tokenAddress}, skipping`
        );
        console.log(simulation.error);
        continue;
      }
      if (simulation.firstRevert !== undefined) {
        console.log(
          `Simulation Error (based on firstRevert) on token ${bestCrossedMarket.tokenAddress}, skipping`
        );
        console.log(simulation);
        continue;
      }
      console.log(
        `Submitting bundle, profit sent to miner: ${bigNumberToDecimal(
          simulation.coinbaseDiff
        )}, effective gas price: ${bigNumberToDecimal(
          simulation.coinbaseDiff.div(simulation.totalGasUsed),
          9
        )} GWEI`
      );
      const bundlePromises = _.map(
        [blockNumber + 1, blockNumber + 2],
        (targetBlockNumber) =>
          this.flashbotsProvider.sendRawBundle(signedBundle, targetBlockNumber)
      );
      await Promise.all(bundlePromises);
      return;
    }
    throw new Error("No arbitrage submitted to relay");
  }
}
