// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AevumPay, IERC20Metadata} from "../src/AevumPay.sol";
import {MockTUSD8} from "./MockTUSD8.sol";

interface TestVm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes calldata data) external;
    function expectRevert(bytes4 selector) external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data, address emitter) external;
}

contract FeeToken is MockTUSD8 {
    bool public takeFee;

    function enableFee() external {
        takeFee = true;
    }

    function _update(address from, address to, uint256 amount) internal override {
        // Charge only the forwarding transfer, so the revert happens after transferFrom.
        if (takeFee && from == msg.sender && from != address(0) && to != address(0)) {
            super._update(from, address(0), 1);
            amount -= 1;
        }
        super._update(from, to, amount);
    }
}

contract AevumPayTest {
    TestVm private constant VM = TestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant MERCHANT = address(0x1001);
    address private constant PAYEE = address(0x1002);
    address private constant PAYER = address(0x1003);
    uint256 private constant AMOUNT = 25_000_001;

    MockTUSD8 private token;
    AevumPay private pay;
    uint64 private expiry;

    event InvoiceCreated(
        uint256 indexed id, address indexed merchant, address indexed payee, uint256 amount, uint64 expiry, string memo
    );
    event InvoicePaid(uint256 indexed id, address indexed payer, address indexed payee, uint256 amount);
    event InvoiceCancelled(uint256 indexed id, address indexed merchant);

    function setUp() public {
        token = new MockTUSD8();
        pay = new AevumPay(token);
        expiry = uint64(block.timestamp + 1 hours);
        token.mint(PAYER, AMOUNT * 2);
    }

    function testCreateRequest() public {
        VM.expectEmit(true, true, true, true, address(pay));
        emit InvoiceCreated(1, MERCHANT, PAYEE, AMOUNT, expiry, "Order 42");
        uint256 id = _create();
        AevumPay.Invoice memory invoice = pay.getInvoice(id);
        assert(id == 1 && pay.nextInvoiceId() == 2);
        assert(invoice.merchant == MERCHANT && invoice.payee == PAYEE);
        assert(invoice.amount == AMOUNT && invoice.expiry == expiry);
        assert(keccak256(bytes(invoice.memo)) == keccak256("Order 42"));
        assert(invoice.status == AevumPay.Status.Open && invoice.payer == address(0));
    }

    function testPayInFullForwardsTheExactAmount() public {
        uint256 id = _create();
        token.mint(address(pay), 5);
        _approve();
        VM.expectEmit(true, true, true, true, address(pay));
        emit InvoicePaid(id, PAYER, PAYEE, AMOUNT);
        VM.prank(PAYER);
        pay.payInvoice(id, AMOUNT);

        AevumPay.Invoice memory invoice = pay.getInvoice(id);
        assert(invoice.status == AevumPay.Status.Paid && invoice.payer == PAYER);
        assert(token.balanceOf(PAYEE) == AMOUNT);
        assert(token.balanceOf(PAYER) == AMOUNT);
        assert(token.balanceOf(address(pay)) == 5);
        assert(token.allowance(PAYER, address(pay)) == 0);
        VM.warp(expiry);
        assert(pay.getInvoice(id).status == AevumPay.Status.Paid);
    }

    function testRejectOverpayment() public {
        _rejectWrongAmount(AMOUNT + 1);
    }

    function testRejectUnderpayment() public {
        _rejectWrongAmount(AMOUNT - 1);
    }

    function testRejectPaymentAtExpiry() public {
        uint256 id = _create();
        _approve();
        VM.warp(expiry);
        assert(pay.getInvoice(id).status == AevumPay.Status.Expired);
        _expectNotOpen(AevumPay.Status.Expired);
        VM.prank(PAYER);
        pay.payInvoice(id, AMOUNT);
    }

    function testRejectDoublePayment() public {
        uint256 id = _create();
        _approve();
        VM.prank(PAYER);
        pay.payInvoice(id, AMOUNT);
        _approve();
        _expectNotOpen(AevumPay.Status.Paid);
        VM.prank(PAYER);
        pay.payInvoice(id, AMOUNT);
    }

    function testMerchantCancellationPreventsPayment() public {
        uint256 id = _create();
        VM.expectEmit(true, true, false, true, address(pay));
        emit InvoiceCancelled(id, MERCHANT);
        VM.prank(MERCHANT);
        pay.cancelInvoice(id);
        assert(pay.getInvoice(id).status == AevumPay.Status.Cancelled);

        _expectNotOpen(AevumPay.Status.Cancelled);
        VM.prank(PAYER);
        pay.payInvoice(id, AMOUNT);
    }

    function testPayeeCannotCancelUnlessTheyCreatedTheInvoice() public {
        uint256 id = _create();
        VM.expectRevert(AevumPay.NotMerchant.selector);
        VM.prank(PAYEE);
        pay.cancelInvoice(id);
    }

    function testCannotCancelPaidInvoice() public {
        uint256 id = _create();
        _approve();
        VM.prank(PAYER);
        pay.payInvoice(id, AMOUNT);
        _expectNotOpen(AevumPay.Status.Paid);
        VM.prank(MERCHANT);
        pay.cancelInvoice(id);
    }

    function testMissingInvoiceCannotBePaid() public {
        _expectNotOpen(AevumPay.Status.Missing);
        VM.prank(PAYER);
        pay.payInvoice(7, AMOUNT);
    }

    function testMissingAllowanceLeavesInvoiceOpenForRetry() public {
        uint256 id = _create();
        VM.expectRevert(
            abi.encodeWithSignature("ERC20InsufficientAllowance(address,uint256,uint256)", address(pay), 0, AMOUNT)
        );
        VM.prank(PAYER);
        pay.payInvoice(id, AMOUNT);
        assert(pay.getInvoice(id).status == AevumPay.Status.Open);

        _approve();
        VM.prank(PAYER);
        pay.payInvoice(id, AMOUNT);
        assert(pay.getInvoice(id).status == AevumPay.Status.Paid);
    }

    function testInexactForwardingRollsBackBothTokenTransfers() public {
        FeeToken feeToken = new FeeToken();
        pay = new AevumPay(feeToken);
        token = feeToken;
        token.mint(PAYER, AMOUNT);
        uint256 id = _create();
        _approve();
        feeToken.enableFee();

        VM.expectRevert(AevumPay.InexactTransfer.selector);
        VM.prank(PAYER);
        pay.payInvoice(id, AMOUNT);
        assert(pay.getInvoice(id).status == AevumPay.Status.Open);
        assert(token.balanceOf(PAYER) == AMOUNT && token.balanceOf(PAYEE) == 0);
        assert(token.balanceOf(address(pay)) == 0);
        assert(token.allowance(PAYER, address(pay)) == AMOUNT);
    }

    function testEnforcesAmountCapAndPositiveAmount() public {
        uint256 cap = pay.MAX_AMOUNT();
        assert(pay.createInvoice(PAYEE, cap, "", expiry) == 1);
        VM.expectRevert(AevumPay.InvalidAmount.selector);
        pay.createInvoice(PAYEE, cap + 1, "", expiry);
        VM.expectRevert(AevumPay.InvalidAmount.selector);
        pay.createInvoice(PAYEE, 0, "", expiry);
    }

    function testRejectsInvalidPayeeExpiryAndMemo() public {
        VM.expectRevert(AevumPay.InvalidPayee.selector);
        pay.createInvoice(address(0), AMOUNT, "", expiry);
        VM.expectRevert(AevumPay.InvalidPayee.selector);
        pay.createInvoice(address(pay), AMOUNT, "", expiry);
        VM.expectRevert(AevumPay.InvalidExpiry.selector);
        pay.createInvoice(PAYEE, AMOUNT, "", uint64(block.timestamp));
        VM.expectRevert(AevumPay.MemoTooLong.selector);
        pay.createInvoice(PAYEE, AMOUNT, string(new bytes(161)), expiry);
    }

    function testRejectsTokenAddressWithoutCode() public {
        VM.expectRevert(AevumPay.InvalidToken.selector);
        new AevumPay(IERC20Metadata(address(0)));
    }

    function _create() private returns (uint256) {
        VM.prank(MERCHANT);
        return pay.createInvoice(PAYEE, AMOUNT, "Order 42", expiry);
    }

    function _approve() private {
        VM.prank(PAYER);
        token.approve(address(pay), AMOUNT);
    }

    function _rejectWrongAmount(uint256 amount) private {
        uint256 id = _create();
        _approve();
        VM.expectRevert(abi.encodeWithSelector(AevumPay.IncorrectAmount.selector, AMOUNT, amount));
        VM.prank(PAYER);
        pay.payInvoice(id, amount);
    }

    function _expectNotOpen(AevumPay.Status status) private {
        VM.expectRevert(abi.encodeWithSelector(AevumPay.InvoiceNotOpen.selector, status));
    }
}
