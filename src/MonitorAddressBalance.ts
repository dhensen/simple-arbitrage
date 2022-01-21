import { BigNumber, Contract, providers } from "ethers";
import { ConnectionInfo, formatEther } from "ethers/lib/utils";
import { sys } from "typescript";
import * as fs from "fs";
import dotenv from "dotenv";

dotenv.config();


function getEnvValue(name: string): string {
  const value = process.env[name];
  if (value !== undefined) {
    return value;
  }
  console.warn(`${name} environment variable is undefined`);
  process.exit(1);
}

const INFURA_PROD = getEnvValue("INFURA_PROD");
const INFURA_API_USER = getEnvValue("INFURA_API_USER");
const INFURA_API_SECRET = getEnvValue("INFURA_API_SECRET");

const connectionInfo: ConnectionInfo = {
  url: INFURA_PROD,
  user: INFURA_API_USER,
  password: INFURA_API_SECRET,
};

const provider = new providers.StaticJsonRpcProvider(connectionInfo);
const wethAbi = fs.readFileSync("./abis/weth_abi.json", "utf8");
const wethContract = new Contract(
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  wethAbi
);
const readOnlyWethContract = wethContract.connect(provider);
const address = sys.args[1];


let previousWethBalance: number;
provider.on("block", async (blockNumber) => {
  console.log(blockNumber);
  //   console.log(address);

//   const balance = await provider.getBalance(address);
//     console.log(balance);

  if (!previousWethBalance) {
    console.log(`monitoring address balance: ${address}`);
  }
  const wethBalance = await readOnlyWethContract.balanceOf(address);
  if (previousWethBalance && previousWethBalance - wethBalance !== 0) {
    console.log(
      `Balance changed on block ${blockNumber} for address ${address}:`
    );
    console.log(formatEther(wethBalance));
  }
  previousWethBalance = wethBalance;
});
