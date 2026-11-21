import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { getBytes, keccak256 } from "ethers";

const artifact = new URL("../out/AevumPay.sol/AevumPay.json", import.meta.url);
const output = new URL("../web/runtime.mjs", import.meta.url);
const { deployedBytecode } = JSON.parse(await readFile(artifact, "utf8"));
const slots = Object.values(deployedBytecode.immutableReferences);
assert.equal(slots.length, 1, "The token should be the only immutable");
const bytes = getBytes(deployedBytecode.object);
for (const { start, length } of slots[0]) {
  assert.equal(length, 32);
  assert(bytes.slice(start, start + length).every((byte) => byte === 0), "Expected empty immutable placeholder");
}
const source = "// Generated from the Foundry artifact by scripts/update-runtime.mjs.\n" +
  `export const RUNTIME_HASH = "${keccak256(bytes)}";\n` +
  `export const TOKEN_OFFSETS = ${JSON.stringify(slots[0].map(({ start }) => start))};\n`;
if (process.argv.includes("--check")) assert.equal(await readFile(output, "utf8"), source);
else await writeFile(output, source);
