import { Contract, getAddress, getBytes, hexlify, keccak256, parseUnits, zeroPadValue } from "ethers";
import { DECIMALS, MAX_AMOUNT, MAX_MEMO_BYTES } from "./network.mjs";
import { RUNTIME_HASH, TOKEN_OFFSETS } from "./runtime.mjs";

export const PAY_ABI = [
  "function token() view returns (address)",
  "function createInvoice(address payee,uint256 amount,string memo,uint64 expiry) returns (uint256)",
  "function getInvoice(uint256 id) view returns ((address merchant,address payee,uint64 expiry,uint256 amount,string memo,uint8 status,address payer))",
  "function cancelInvoice(uint256 id)",
  "function payInvoice(uint256 id,uint256 amount)",
  "event InvoiceCreated(uint256 indexed id,address indexed merchant,address indexed payee,uint256 amount,uint64 expiry,string memo)",
  "error InvoiceNotOpen(uint8 status)",
  "error IncorrectAmount(uint256 expected,uint256 provided)",
  "error NotMerchant()",
  "error InvalidAmount()",
  "error InvalidExpiry()",
  "error InvalidPayee()",
  "error MemoTooLong()",
  "error InexactTransfer()",
  "error ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)",
  "error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)",
];

export const TOKEN_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function mint(address to,uint256 amount)",
];

export const Status = Object.freeze({ Missing: 0n, Open: 1n, Paid: 2n, Cancelled: 3n, Expired: 4n });
export const STATUS_LABEL = ["Missing", "Open", "Paid", "Cancelled", "Expired"];
const RECEIPT_TIMEOUT = 120_000;

export function tokenAmount(input) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(input)) throw new Error("Enter an amount with up to 6 decimal places.");
  const amount = parseUnits(input, DECIMALS);
  if (amount === 0n || amount > MAX_AMOUNT) throw new Error("Enter an amount above 0 and at most 1,000 tUSD8.");
  return amount;
}

export async function openContracts(provider, network, deployment) {
  if ((await provider.getNetwork()).chainId !== BigInt(network.chainId)) {
    throw new Error(`Expected ${network.name} (chain ${network.chainId}).`);
  }
  const address = getAddress(deployment);
  const deployedCode = await provider.getCode(address);
  if (deployedCode === "0x") throw new Error("No contract is deployed at that address.");
  // A payment link can name any address. Authenticate the release code before offering an approval.
  const bytes = getBytes(deployedCode);
  const tokenWord = zeroPadValue(network.token, 32).toLowerCase();
  for (const start of TOKEN_OFFSETS) {
    if (hexlify(bytes.slice(start, start + 32)) !== tokenWord) {
      throw new Error("The address does not contain this release of Aevum Pay with the expected tUSD8 token.");
    }
    bytes.fill(0, start, start + 32);
  }
  if (keccak256(bytes) !== RUNTIME_HASH) throw new Error("The address does not contain this release of Aevum Pay.");
  const pay = new Contract(address, PAY_ABI, provider);
  const token = new Contract(getAddress(network.token), TOKEN_ABI, provider);
  if (getAddress(await pay.token()) !== token.target || await token.decimals() !== BigInt(DECIMALS)
    || await token.symbol() !== "tUSD8") {
    throw new Error("The contract does not use this network’s tUSD8 token.");
  }
  return { provider, pay, token };
}

export async function confirmed(send, label, notify = () => {}) {
  const tx = await send;
  notify(label, tx.hash);
  try {
    const receipt = await tx.wait(1, RECEIPT_TIMEOUT);
    if (receipt?.status !== 1) throw new Error(`${label} did not succeed.`);
    return receipt;
  } catch (error) {
    // A wallet can replace a transaction when the user speeds it up.
    if (error.code === "TRANSACTION_REPLACED" && !error.cancelled && error.receipt?.status === 1) {
      notify(`${label} (replacement)`, error.receipt.hash);
      return error.receipt;
    }
    throw error;
  }
}

export async function createInvoice(context, signer, input, notify) {
  const { pay, provider } = context;
  const payee = getAddress(input.payee);
  const amount = tokenAmount(input.amount);
  const memo = input.memo;
  if (new TextEncoder().encode(memo).length > MAX_MEMO_BYTES) throw new Error("Keep the memo within 160 UTF-8 bytes.");
  if (!Number.isSafeInteger(input.minutes) || input.minutes < 1 || input.minutes > 43_200) {
    throw new Error("Choose an expiry between 1 and 43,200 minutes.");
  }
  const latest = await provider.getBlock("latest");
  const expiry = BigInt(latest.timestamp + input.minutes * 60);
  const receipt = await confirmed(pay.connect(signer).createInvoice(payee, amount, memo, expiry), "Create", notify);
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== pay.target) continue;
    const event = pay.interface.parseLog(log);
    if (event?.name === "InvoiceCreated") return event.args.id;
  }
  throw new Error("The transaction receipt did not contain an InvoiceCreated event.");
}

export async function allowanceFor(context, address) {
  return context.token.allowance(address, context.pay.target);
}

export async function approveInvoice(context, signer, id, notify) {
  const invoice = await readOpen(context, id);
  return confirmed(context.token.connect(signer).approve(context.pay.target, invoice.amount), "Approve", notify);
}

export async function payInvoice(context, signer, id, notify) {
  const invoice = await readOpen(context, id);
  return confirmed(context.pay.connect(signer).payInvoice(id, invoice.amount), "Pay", notify);
}

export async function cancelInvoice(context, signer, id, notify) {
  await readOpen(context, id);
  return confirmed(context.pay.connect(signer).cancelInvoice(id), "Cancel", notify);
}

export async function revokeAllowance(context, signer, notify) {
  return confirmed(context.token.connect(signer).approve(context.pay.target, 0n), "Revoke allowance", notify);
}

async function readOpen(context, id) {
  const invoice = await context.pay.getInvoice(id);
  if (invoice.status !== Status.Open) throw new Error(`Invoice is ${STATUS_LABEL[Number(invoice.status)].toLowerCase()}.`);
  return invoice;
}
