import { copyFile, mkdir } from "node:fs/promises";

const vendor = new URL("../web/vendor/", import.meta.url);
await mkdir(vendor, { recursive: true });
await copyFile(
  new URL("../node_modules/ethers/dist/ethers.min.js", import.meta.url),
  new URL("ethers.min.js", vendor),
);
await copyFile(
  new URL("../node_modules/ethers/LICENSE.md", import.meta.url),
  new URL("ethers-LICENSE.md", vendor),
);
