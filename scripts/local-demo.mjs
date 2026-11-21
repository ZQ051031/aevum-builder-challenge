import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { ContractFactory, JsonRpcProvider, JsonRpcSigner, toQuantity } from "ethers";
import { confirmed, openContracts } from "../web/payments.mjs";
import { runDemo } from "./run-demo.mjs";
import { serve } from "./serve.mjs";

const actors = Object.freeze({
  merchant: "0x0000000000000000000000000000000000001001",
  payer: "0x0000000000000000000000000000000000001002",
});
const chainId = 31337;
const anvil = spawn("anvil", ["--accounts", "0", "--chain-id", String(chainId), "--host", "127.0.0.1", "--port", "0"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let provider;
let server;

function cleanup() {
  server?.close();
  provider?.destroy();
  anvil.kill();
}
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);

try {
  const rpcUrl = await new Promise((resolve, reject) => {
    // Filter the Anvil banner. The simulation has zero generated accounts.
    const lines = createInterface({ input: anvil.stdout });
    const timeout = setTimeout(() => reject(new Error("Anvil did not start within 15 seconds.")), 15_000);
    anvil.once("exit", (code) => {
      clearTimeout(timeout);
      if (server) cleanup();
      reject(new Error(`Anvil stopped (code ${code}).`));
    });
    anvil.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Could not start Anvil: ${error.message}`));
    });
    lines.on("line", (line) => {
      const match = /^Listening on (127\.0\.0\.1:\d+)$/.exec(line);
      if (!match) return;
      clearTimeout(timeout);
      resolve(`http://${match[1]}`);
    });
    anvil.stderr.resume();
  });
  provider = new JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  assert.equal((await provider.getNetwork()).chainId, BigInt(chainId));
  assert.deepEqual(await provider.send("eth_accounts", []), [], "Anvil must start with zero generated accounts");
  for (const actor of Object.values(actors)) {
    await provider.send("anvil_impersonateAccount", [actor]);
    await provider.send("anvil_setBalance", [actor, toQuantity(10n ** 20n)]);
  }
  const merchant = new JsonRpcSigner(provider, actors.merchant);
  const payer = new JsonRpcSigner(provider, actors.payer);
  const token = await deploy(merchant, "MockTUSD8.sol/MockTUSD8.json");
  const pay = await deploy(merchant, "AevumPay.sol/AevumPay.json", token.target);
  await confirmed(token.mint(actors.payer, 100_000_000n), "Mint local test tokens");

  const network = { chainId, name: "Local Anvil", token: token.target };
  await assert.rejects(openContracts(provider, network, token.target), /does not contain this release/);
  const context = await openContracts(provider, network, pay.target);
  console.log(`Local Anvil ${chainId} | mock tUSD8 ${token.target} | Aevum Pay ${pay.target}`);
  await runDemo(context, merchant, payer);
  if (process.argv.includes("--serve")) {
    server = await serve({
      config: { network, deployment: pay.target, actors },
      rpcUrl,
    });
  } else {
    cleanup();
  }
} catch (error) {
  console.error(error.shortMessage ?? error.message);
  process.exitCode = 1;
  cleanup();
}

async function deploy(signer, path, ...args) {
  const artifact = JSON.parse(await readFile(new URL(`../out/${path}`, import.meta.url), "utf8"));
  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, signer);
  const contract = await factory.deploy(...args);
  await confirmed(Promise.resolve(contract.deploymentTransaction()), "Local deployment");
  return contract;
}
