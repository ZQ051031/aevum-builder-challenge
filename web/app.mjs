import { BrowserProvider, JsonRpcProvider, JsonRpcSigner, formatUnits, getAddress, toQuantity } from "ethers";
import { AEVUM, DECIMALS } from "./network.mjs";
import {
  Status, STATUS_LABEL, allowanceFor, approveInvoice, cancelInvoice, createInvoice, openContracts, payInvoice,
  revokeAllowance,
} from "./payments.mjs";

const $ = (id) => document.getElementById(id);
const rpcOptions = { batchMaxCount: 1, cacheTimeout: -1 };
const url = new URL(location.href);
const state = {
  local: null, network: AEVUM, context: null, account: null, id: null, invoice: null, allowance: null, busy: false,
};
let provider;
let wallet;
let walletProvider;

function announce(message, error = false) {
  const notice = $("notice");
  notice.hidden = !message;
  notice.textContent = message;
  notice.dataset.error = error;
}

function explain(error) {
  if (error.code === "ACTION_REJECTED" || error.code === 4001) return "You declined the wallet request.";
  if (error.code === "TIMEOUT") return "Confirmation timed out. Check the transaction hash before retrying.";
  const messages = {
    InvoiceNotOpen: "This invoice is no longer open. Look it up again to refresh its status.",
    InvalidPayee: "Choose a valid payee address other than the invoice contract.",
    ERC20InsufficientBalance: "Your account needs more tUSD8. Use the testnet faucet.",
    ERC20InsufficientAllowance: "The allowance is too low. Look up the invoice and approve the exact amount again.",
  };
  if (error.revert?.name in messages) return messages[error.revert.name];
  if (error.code === "INSUFFICIENT_FUNDS") return "Your account needs testnet gas.";
  return error.shortMessage ?? error.message ?? "The request failed. Try again.";
}

async function act(operation) {
  if (state.busy) return;
  state.busy = true;
  announce("");
  render();
  try {
    await operation();
  } catch (error) {
    announce(explain(error), true);
  } finally {
    state.busy = false;
    render();
  }
}

function short(address) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function explorerLink(element, resource, address, label) {
  element.textContent = label;
  element.title = address || "";
  element.removeAttribute("href");
  if (state.network.explorer && address) {
    element.href = `${state.network.explorer}/${resource}/${address}`;
    element.target = "_blank";
    element.rel = "noopener noreferrer";
  }
}

function render() {
  const { account, context, invoice, id, allowance, busy } = state;
  const open = invoice?.status === Status.Open;
  const connected = Boolean(account);
  const showInvoice = Boolean(invoice);
  $("account").hidden = !connected || Boolean(state.local);
  $("account").textContent = account ? short(account) : "";
  $("account").title = account ?? "";
  $("connect").textContent = connected ? "Reconnect wallet" : "Connect wallet";
  $("invoice").hidden = !showInvoice;
  $("invoice-empty").hidden = showInvoice;
  $("create").disabled = busy || !context || !connected;
  $("lookup").disabled = busy || !context;
  $("connect").disabled = busy;
  $("role-merchant").disabled = busy;
  $("role-payer").disabled = busy;
  $("role-merchant").setAttribute("aria-pressed", Boolean(connected && account === state.local?.actors.merchant));
  $("role-payer").setAttribute("aria-pressed", Boolean(connected && account === state.local?.actors.payer));
  $("deployment-form").querySelector("button").disabled = busy;
  const mayPay = open && connected && allowance !== null;
  $("approve").hidden = !mayPay || allowance === invoice?.amount;
  $("pay").hidden = !mayPay || allowance !== invoice?.amount;
  $("cancel").hidden = !open || account !== invoice.merchant;
  for (const name of ["approve", "pay", "share", "cancel", "revoke"]) $(name).disabled = busy;
  $("allowance-panel").hidden = !connected || allowance === null || allowance === 0n;
  $("allowance").textContent = allowance === null ? "" : `Active allowance · ${formatUnits(allowance, DECIMALS)} tUSD8`;
  if (!showInvoice) return;

  $("invoice-number").textContent = `Invoice #${id}`;
  $("invoice-amount").textContent = `${formatUnits(invoice.amount, DECIMALS)} tUSD8`;
  $("invoice-status").textContent = STATUS_LABEL[Number(invoice.status)];
  $("invoice-status").dataset.status = $("invoice-status").textContent;
  $("invoice-payee").textContent = invoice.payee;
  $("invoice-merchant").textContent = invoice.merchant;
  $("invoice-memo").textContent = invoice.memo || "—";
  $("invoice-expiry").textContent = new Date(Number(invoice.expiry) * 1000).toLocaleString();
  $("payer-row").hidden = invoice.status !== Status.Paid;
  $("invoice-payer").textContent = invoice.payer;
}

function txActivity(label, hash) {
  const item = document.createElement("li");
  const proof = document.createElement(state.network.explorer ? "a" : "code");
  item.textContent = label;
  explorerLink(proof, "tx", hash, hash);
  item.append(proof);
  $("transactions").prepend(item);
  $("activity").hidden = false;
  announce(`${label} transaction sent. Waiting for confirmation…`);
}

async function refreshAllowance() {
  const { account, context } = state;
  state.allowance = null;
  if (account && context) {
    const allowance = await allowanceFor(context, account);
    if (state.account === account && state.context === context) state.allowance = allowance;
  }
}

async function refreshInvoice(id) {
  state.invoice = null;
  state.id = id;
  const invoice = await state.context.pay.getInvoice(id);
  if (invoice.status === Status.Missing) throw new Error(`Invoice #${id} does not exist on this deployment.`);
  state.invoice = invoice;
  $("invoice-id").value = String(id);
  await refreshAllowance();
}

function parseId(value) {
  if (!/^[1-9][0-9]{0,77}$/.test(value) || BigInt(value) >= 2n ** 256n) {
    throw new Error("Enter a positive invoice ID.");
  }
  return BigInt(value);
}

async function loadDeployment(address, invoiceId) {
  state.context = await openContracts(provider, state.network, address);
  state.invoice = null;
  state.id = null;
  $("invoice-id").value = "";
  $("transactions").replaceChildren();
  $("activity").hidden = true;
  $("deployment").value = state.context.pay.target;
  explorerLink($("contract-link"), "address", state.context.pay.target, short(state.context.pay.target));
  if (invoiceId) await refreshInvoice(parseId(invoiceId));
  else await refreshAllowance();
}

async function selectAccount(address) {
  state.account = address;
  if (address && !$("payee").value) $("payee").value = address;
  await refreshAllowance();
}

function invalidateWallet() {
  state.account = null;
  state.allowance = null;
  render();
  if (!state.busy) announce("Wallet changed. Reconnect it to continue.");
}

async function connectWallet() {
  const injected = window.ethereum;
  if (!injected?.request) throw new Error("Open this page in a browser with an Ethereum-compatible wallet.");
  if (wallet !== injected) {
    wallet = injected;
    wallet.on?.("accountsChanged", invalidateWallet);
    wallet.on?.("chainChanged", invalidateWallet);
    wallet.on?.("disconnect", invalidateWallet);
  }
  const chain = toQuantity(AEVUM.chainId);
  await wallet.request({ method: "eth_requestAccounts" });
  if (BigInt(await wallet.request({ method: "eth_chainId" })) !== BigInt(AEVUM.chainId)) {
    try {
      await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain }] });
    } catch (error) {
      if (error.code !== 4902 && error.data?.originalError?.code !== 4902) throw error;
      await wallet.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: chain, chainName: AEVUM.name,
          nativeCurrency: { name: "Testnet QDAY", symbol: "tQDAY", decimals: 18 },
          rpcUrls: [AEVUM.rpcUrl], blockExplorerUrls: [AEVUM.explorer],
        }],
      });
      if (BigInt(await wallet.request({ method: "eth_chainId" })) !== BigInt(AEVUM.chainId)) {
        await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain }] });
      }
    }
  }
  const [account] = await wallet.request({ method: "eth_accounts" });
  if (!account) throw new Error("The wallet did not share an account.");
  walletProvider?.destroy();
  walletProvider = new BrowserProvider(wallet, { name: AEVUM.name, chainId: AEVUM.chainId });
  await selectAccount(getAddress(account));
  announce("Wallet connected to QDay Aevum testnet.");
}

async function getSigner() {
  const account = state.account;
  if (!account) throw new Error("Connect a wallet or select a local demo identity.");
  if (state.local) return new JsonRpcSigner(provider, account);

  const chain = await wallet.request({ method: "eth_chainId" });
  const [selected] = await wallet.request({ method: "eth_accounts" });
  if (BigInt(chain) !== BigInt(AEVUM.chainId) || !selected || getAddress(selected) !== account
      || state.account !== account) {
    invalidateWallet();
    throw new Error("Reconnect your wallet on QDay Aevum before sending a transaction.");
  }
  return walletProvider.getSigner(account);
}

async function changeInvoice(operation, success) {
  const id = state.id;
  const signer = await getSigner();
  try {
    await operation(state.context, signer, id, txActivity);
  } catch (error) {
    // Another tab or wallet may have cancelled or settled the invoice.
    await refreshInvoice(id).catch(() => {});
    throw error;
  }
  await refreshInvoice(id);
  announce(success(id));
}

function onSubmit(id, callback) {
  $(id).addEventListener("submit", (event) => {
    event.preventDefault();
    void act(callback);
  });
}

function onClick(id, callback) {
  $(id).addEventListener("click", () => void act(callback));
}

onSubmit("deployment-form", async () => {
  await loadDeployment($("deployment").value.trim());
  announce("Aevum Pay contract loaded.");
});
onSubmit("lookup-form", async () => {
  await refreshInvoice(parseId($("invoice-id").value.trim()));
  announce(`Invoice #${state.id} is ${STATUS_LABEL[Number(state.invoice.status)].toLowerCase()}.`);
});
onSubmit("create-form", async () => {
  const invoice = {
    payee: $("payee").value.trim(), amount: $("amount").value.trim(), memo: $("memo").value,
    minutes: Number($("minutes").value),
  };
  const id = await createInvoice(state.context, await getSigner(), invoice, txActivity);
  await refreshInvoice(id);
  announce(`Invoice #${id} created. Copy its link to share it.`);
});
onClick("connect", connectWallet);
for (const role of ["merchant", "payer"]) {
  onClick(`role-${role}`, async () => {
    await selectAccount(state.local.actors[role]);
    if (state.id) await refreshInvoice(state.id);
    announce(`Using the local demo ${role}.`);
  });
}
onClick("approve", () => changeInvoice(approveInvoice, () => "Exact allowance approved. You can now pay the invoice."));
onClick("pay", () => changeInvoice(payInvoice, (id) => `Invoice #${id} paid and forwarded to its payee.`));
onClick("cancel", () => changeInvoice(cancelInvoice, (id) => `Invoice #${id} cancelled.`));
onClick("revoke", async () => {
  await revokeAllowance(state.context, await getSigner(), txActivity);
  await refreshAllowance();
  announce("Token allowance revoked.");
});
onClick("share", async () => {
  const shared = new URL(location.href);
  shared.search = new URLSearchParams({ contract: state.context.pay.target, invoice: String(state.id) });
  shared.hash = "";
  if (!navigator.clipboard) {
    window.prompt("Copy the payment link", shared.href);
    return;
  }
  await navigator.clipboard.writeText(shared.href);
  announce("Payment link copied.");
});

await act(async () => {
  if (["127.0.0.1", "localhost"].includes(location.hostname)) {
    const response = await fetch("./local-config.json");
    if (response.ok) state.local = await response.json();
  }
  if (state.local) {
    state.network = state.local.network;
    $("demo-roles").hidden = false;
    $("connect").hidden = true;
    $("faucet").hidden = true;
    $("environment-note").textContent = "Local simulation · Mock tUSD8 · Resets on restart";
  } else {
    $("deployment-form").hidden = false;
  }

  provider = new JsonRpcProvider(state.local ? new URL("./local-rpc", url).href : AEVUM.rpcUrl, undefined, rpcOptions);
  $("network").textContent = state.local ? "Local Anvil · Simulation" : "QDay Aevum · Testnet";
  $("chain-id").textContent = state.network.chainId;
  explorerLink($("token-link"), "token", state.network.token, short(state.network.token));
  $("token-link").title = `tUSD8 · ${state.network.token}`;
  $("token-link").textContent = `tUSD8 · ${short(state.network.token)}`;

  const address = state.local?.deployment || url.searchParams.get("contract");
  const invoiceId = url.searchParams.get("invoice");
  if (state.local) {
    await selectAccount(state.local.actors.merchant);
    if (url.searchParams.has("contract") && url.searchParams.get("contract").toLowerCase() !== address.toLowerCase()) {
      await loadDeployment(address);
      throw new Error("The shared link points to a different local deployment.");
    }
  }
  if (address) {
    $("deployment").value = address;
    await loadDeployment(address, invoiceId);
  }
});
