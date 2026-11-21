// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Single-token invoices settled atomically from the payer to a fixed payee.
contract AevumPay is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_AMOUNT = 1_000e6;
    uint256 public constant MAX_MEMO_BYTES = 160;
    IERC20 private immutable TOKEN;

    enum Status {
        Missing,
        Open,
        Paid,
        Cancelled,
        Expired
    }

    struct Invoice {
        address merchant;
        address payee;
        uint64 expiry;
        uint256 amount;
        string memo;
        Status status;
        address payer;
    }

    uint256 public nextInvoiceId = 1;
    mapping(uint256 => Invoice) private invoices;

    event InvoiceCreated(
        uint256 indexed id, address indexed merchant, address indexed payee, uint256 amount, uint64 expiry, string memo
    );
    event InvoicePaid(uint256 indexed id, address indexed payer, address indexed payee, uint256 amount);
    event InvoiceCancelled(uint256 indexed id, address indexed merchant);

    error InvalidToken();
    error InvalidPayee();
    error InvalidAmount();
    error InvalidExpiry();
    error MemoTooLong();
    error InvoiceNotOpen(Status status);
    error IncorrectAmount(uint256 expected, uint256 provided);
    error NotMerchant();
    error InexactTransfer();

    constructor(IERC20Metadata paymentToken) {
        if (address(paymentToken).code.length == 0 || paymentToken.decimals() != 6) {
            revert InvalidToken();
        }
        TOKEN = paymentToken;
    }

    function token() external view returns (IERC20) {
        return TOKEN;
    }

    function createInvoice(address payee, uint256 amount, string calldata memo, uint64 expiry)
        external
        returns (uint256 id)
    {
        if (payee == address(0) || payee == address(this)) revert InvalidPayee();
        if (amount == 0 || amount > MAX_AMOUNT) revert InvalidAmount();
        if (expiry <= block.timestamp) revert InvalidExpiry();
        if (bytes(memo).length > MAX_MEMO_BYTES) revert MemoTooLong();

        id = nextInvoiceId++;
        invoices[id] = Invoice({
            merchant: msg.sender,
            payee: payee,
            expiry: expiry,
            amount: amount,
            memo: memo,
            status: Status.Open,
            payer: address(0)
        });
        emit InvoiceCreated(id, msg.sender, payee, amount, expiry, memo);
    }

    /// @notice Expiry is derived from the current block timestamp and requires no transaction.
    function getInvoice(uint256 id) external view returns (Invoice memory invoice) {
        invoice = invoices[id];
        invoice.status = _status(invoice.status, invoice.expiry);
    }

    function cancelInvoice(uint256 id) external {
        Invoice storage invoice = invoices[id];
        _requireOpen(invoice);
        if (msg.sender != invoice.merchant) revert NotMerchant();

        invoice.status = Status.Cancelled;
        emit InvoiceCancelled(id, msg.sender);
    }

    function payInvoice(uint256 id, uint256 amount) external nonReentrant {
        Invoice storage invoice = invoices[id];
        _requireOpen(invoice);
        if (amount != invoice.amount) revert IncorrectAmount(invoice.amount, amount);

        // Any failed token call or balance check also rolls back the invoice state.
        invoice.status = Status.Paid;
        invoice.payer = msg.sender;
        uint256 previousBalance = TOKEN.balanceOf(address(this));
        TOKEN.safeTransferFrom(msg.sender, address(this), amount);
        if (TOKEN.balanceOf(address(this)) != previousBalance + amount) revert InexactTransfer();

        uint256 previousPayeeBalance = TOKEN.balanceOf(invoice.payee);
        TOKEN.safeTransfer(invoice.payee, amount);
        if (
            TOKEN.balanceOf(invoice.payee) != previousPayeeBalance + amount
                || TOKEN.balanceOf(address(this)) != previousBalance
        ) revert InexactTransfer();

        emit InvoicePaid(id, msg.sender, invoice.payee, amount);
    }

    function _requireOpen(Invoice storage invoice) private view {
        Status status = _status(invoice.status, invoice.expiry);
        if (status != Status.Open) revert InvoiceNotOpen(status);
    }

    function _status(Status status, uint64 expiry) private view returns (Status) {
        return status == Status.Open && block.timestamp >= expiry ? Status.Expired : status;
    }
}
