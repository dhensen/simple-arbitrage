import { BigNumber, Wallet } from "ethers";
import { random } from "lodash";

export const ETHER = BigNumber.from(10).pow(18);

export function bigNumberToDecimal(value: BigNumber, base = 18): number {
  const divisor = BigNumber.from(10).pow(base);
  return value.mul(10000).div(divisor).toNumber() / 10000;
}

export function getDefaultRelaySigningKey(): string {
  console.warn(
    "You have not specified an explicity FLASHBOTS_RELAY_SIGNING_KEY environment variable. Creating random signing key, this searcher will not be building a reputation for next run"
  );
  return createRandomPrivateKey();
}

export function createRandomPrivateKey(): string {
  const randomPrivateKey = Wallet.createRandom().privateKey;
  console.warn("Random private key generated: " + randomPrivateKey);
  return randomPrivateKey;
}

if (process.argv && process.argv[2] == "genpk") {
  createRandomPrivateKey();
}
