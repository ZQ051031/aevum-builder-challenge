import { JsonRpcProvider, Wallet } from "ethers";
import { AEVUM } from "../web/network.mjs";
import { openContracts } from "../web/payments.mjs";
import { runDemo } from "./run-demo.mjs";

const provider = new JsonRpcProvider(AEVUM.rpcUrl, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
try {
  const { AEVUM_PAY_ADDRESS, AEVUM_MERCHANT_KEY, AEVUM_PAYER_KEY } = process.env;
  if (!AEVUM_PAY_ADDRESS || !AEVUM_MERCHANT_KEY || !AEVUM_PAYER_KEY) {
    throw new Error("Set AEVUM_PAY_ADDRESS, AEVUM_MERCHANT_KEY and AEVUM_PAYER_KEY before running the testnet demo.");
  }
  if (![AEVUM_MERCHANT_KEY, AEVUM_PAYER_KEY].every((key) => /^0x[\da-fA-F]{64}$/.test(key))) {
    throw new Error("Supply testnet-only signing keys as 0x-prefixed 32-byte hex values.");
  }
  const context = await openContracts(provider, AEVUM, AEVUM_PAY_ADDRESS);
  const merchant = new Wallet(AEVUM_MERCHANT_KEY, provider);
  const payer = new Wallet(AEVUM_PAYER_KEY, provider);
  await runDemo(context, merchant, payer, AEVUM.explorer);
} catch (error) {
  // Some library errors carry function arguments. Never print full error objects with key inputs.
  console.error(error.code ? `Testnet demo failed (${error.code}). Check funds, gas and deployment.` : error.message);
  process.exitCode = 1;
} finally {
  provider.destroy();
}
