import assert from "node:assert/strict";
import { formatUnits } from "ethers";
import { DECIMALS } from "../web/network.mjs";
import { allowanceFor, approveInvoice, createInvoice, payInvoice, Status } from "../web/payments.mjs";

export async function runDemo(context, merchant, payer, explorer) {
  const payee = await merchant.getAddress();
  const payerAddress = await payer.getAddress();
  assert.notEqual(payee, payerAddress, "Use separate merchant and payer addresses");
  const payeeBefore = await context.token.balanceOf(payee);
  const payerBefore = await context.token.balanceOf(payerAddress);
  const contractBefore = await context.token.balanceOf(context.pay.target);
  const notify = (label, hash) => {
    console.log(`${label} tx ${hash}`);
    if (explorer) console.log(`${explorer}/tx/${hash}`);
  };

  const id = await createInvoice(context, merchant, {
    payee, amount: "1.25", memo: "Demo order A-1042", minutes: 30,
  }, notify);
  const invoice = await context.pay.getInvoice(id);
  assert.equal(invoice.merchant, payee);
  assert.equal(invoice.payee, payee);
  assert.equal(invoice.status, Status.Open);
  assert.equal(invoice.amount, 1_250_000n);
  assert.equal(invoice.memo, "Demo order A-1042");
  await approveInvoice(context, payer, id, notify);
  assert.equal(await allowanceFor(context, payerAddress), invoice.amount);
  await payInvoice(context, payer, id, notify);

  const paid = await context.pay.getInvoice(id);
  assert.equal(paid.status, Status.Paid);
  assert.equal(paid.payer, payerAddress);
  assert.equal(await context.token.balanceOf(payee), payeeBefore + invoice.amount);
  assert.equal(await context.token.balanceOf(payerAddress), payerBefore - invoice.amount);
  assert.equal(await context.token.balanceOf(context.pay.target), contractBefore);
  assert.equal(await allowanceFor(context, payerAddress), 0n);
  console.log(`PASS: invoice #${id} settled ${formatUnits(paid.amount, DECIMALS)} tUSD8 and consumed the exact allowance.`);
}
