import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { Contract, providers, Wallet } from "ethers";
import { BUNDLE_EXECUTOR_ABI } from "./abi";
import { UniswappyV2EthPair } from "./UniswappyV2EthPair";
import { FACTORY_ADDRESSES } from "./addresses";
import { Arbitrage } from "./Arbitrage";
import { get } from "https";
import { getDefaultRelaySigningKey } from "./utils";

const USE_TESTNET = process.env.USE_TESTNET === "true";

let CHAIN_ID = 1;

if (USE_TESTNET) {
  CHAIN_ID = 5;
}

const ETHEREUM_RPC_URL =
  process.env.ETHEREUM_RPC_URL || "http://127.0.0.1:8545";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const BUNDLE_EXECUTOR_ADDRESS = process.env.BUNDLE_EXECUTOR_ADDRESS || "";

const FLASHBOTS_RELAY_SIGNING_KEY =
  process.env.FLASHBOTS_RELAY_SIGNING_KEY || getDefaultRelaySigningKey();

const MINER_REWARD_PERCENTAGE = parseInt(
  process.env.MINER_REWARD_PERCENTAGE || "80"
);

if (PRIVATE_KEY === "") {
  console.warn("Must provide PRIVATE_KEY environment variable");
  process.exit(1);
}
if (BUNDLE_EXECUTOR_ADDRESS === "") {
  console.warn(
    "Must provide BUNDLE_EXECUTOR_ADDRESS environment variable. Please see README.md"
  );
  process.exit(1);
}

if (FLASHBOTS_RELAY_SIGNING_KEY === "") {
  console.warn(
    "Must provide FLASHBOTS_RELAY_SIGNING_KEY. Please see https://github.com/flashbots/pm/blob/main/guides/searcher-onboarding.md"
  );
  process.exit(1);
}

function requireEnv(name: string | number) {
  if (process.env[name] === "") {
    console.warn(
      `Must provide ${name} environment variable. Please see README.md`
    );
    process.exit(1);
  }
}

const HEALTHCHECK_URL = process.env.HEALTHCHECK_URL || "";
const INFURA_API_USER = process.env.INFURA_API_USER;
const INFURA_API_SECRET = process.env.INFURA_API_SECRET;
requireEnv("INFURA_API_USER");
requireEnv("INFURA_API_SECRET");

const connectionInfo = {
  url: ETHEREUM_RPC_URL,
  user: INFURA_API_USER,
  password: INFURA_API_SECRET,
};
const provider = new providers.StaticJsonRpcProvider(connectionInfo);

const arbitrageSigningWallet = new Wallet(PRIVATE_KEY);
const flashbotsRelaySigningWallet = new Wallet(FLASHBOTS_RELAY_SIGNING_KEY);

function healthcheck() {
  if (HEALTHCHECK_URL === "") {
    return;
  }
  get(HEALTHCHECK_URL).on("error", console.error);
}

async function createFlashBotBundleProvider() {
  if (USE_TESTNET) {
    console.log("create flashbotsbundleprovider for goerli");
    return await FlashbotsBundleProvider.create(
      provider,
      flashbotsRelaySigningWallet,
      "https://relay-goerli.flashbots.net",
      "goerli"
    );
  }

  console.log("create flashbotsbundleprovider for mainnet");
  return await FlashbotsBundleProvider.create(
    provider,
    flashbotsRelaySigningWallet
  );
}

async function main() {
  console.log(
    "Searcher Wallet Address: " + (await arbitrageSigningWallet.getAddress())
  );
  console.log(
    "Flashbots Relay Signing Wallet Address: " +
      (await flashbotsRelaySigningWallet.getAddress())
  );
  const flashbotsProvider = await createFlashBotBundleProvider();
  const arbitrage = new Arbitrage(
    arbitrageSigningWallet,
    flashbotsProvider,
    new Contract(BUNDLE_EXECUTOR_ADDRESS, BUNDLE_EXECUTOR_ABI, provider)
  );

  const markets = await UniswappyV2EthPair.getUniswapMarketsByToken(
    provider,
    FACTORY_ADDRESSES
  );
  provider.on("block", async (blockNumber) => {
    console.log(`blockNumber: ${blockNumber}`);
    const block = await provider.getBlock(blockNumber);
    await UniswappyV2EthPair.updateReserves(provider, markets.allMarketPairs);
    const bestCrossedMarkets = await arbitrage.evaluateMarkets(
      markets.marketsByToken
    );
    if (bestCrossedMarkets.length === 0) {
      console.log("No crossed markets");
      return;
    }
    bestCrossedMarkets.forEach(Arbitrage.printCrossedMarket);
    const gasPrice = await provider.getGasPrice();
    arbitrage
      .takeCrossedMarkets(
        bestCrossedMarkets,
        blockNumber,
        MINER_REWARD_PERCENTAGE,
        block,
        CHAIN_ID,
        gasPrice
      )
      .then(healthcheck)
      .catch(console.error);
  });
}

main();
