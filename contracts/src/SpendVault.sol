// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice EIP-3009 `receiveWithAuthorization`, implemented by tUSD8 on Aevum.
interface IERC3009Receive {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title SpendVault (Perault)
/// @notice Spending budgets for AI agents, enforced on-chain.
///
///         An owner deposits tUSD8 and opens a *session* for an agent key. The session carries
///         a per-payment cap, a daily cap, a lifetime cap, an expiry and a merchant allowlist.
///         The agent never holds funds or gas: it signs an EIP-712 `PaymentIntent`, and anyone
///         (usually the merchant's facilitator) submits it with `pay`. Every rule is checked here,
///         so a compromised or prompt-injected agent can never spend more than its budget,
///         pay a merchant the owner did not allow, or keep spending after revocation.
///
/// @dev Design notes
///      - No admin, no pause, no upgrade: nobody but the owner can move the owner's funds.
///      - The agent key can only sign payments. It can't withdraw, change caps or open sessions.
///      - Each intent nonce is single-use per session, and each (merchant, orderId) can be paid once,
///        so retries are idempotent: a resubmitted payment fails instead of charging twice.
///      - `revokeAll` costs O(1): it bumps the owner's epoch, which invalidates every older session.
///      - The daily cap resets at 00:00 UTC (calendar days, `block.timestamp / 1 days`).
///      - Agent signatures are checked with `SignatureChecker`, so an agent can be an EOA or an
///        ERC-1271 smart account (ready for ERC-4337 session keys later).
///      - Shanghai-safe: no transient storage, no MCOPY.
contract SpendVault is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    struct Session {
        address owner;
        uint40 expiry; // unix seconds; the session is dead at and after this time
        uint32 epoch; // must equal epochOf[owner] to be live
        bool revoked;
        address agent;
        uint64 day; // UTC day index that `spentToday` refers to
        uint128 perTxCap;
        uint128 dailyCap;
        uint128 totalCap;
        uint128 spentTotal;
        uint128 spentToday;
    }

    /// @notice What the agent signs. Field order is the EIP-712 type order.
    struct PaymentIntent {
        bytes32 sessionId;
        address merchant;
        uint256 amount;
        bytes32 orderId;
        bytes32 nonce;
        uint64 deadline; // unix seconds; the intent is valid up to and including this time
    }

    struct Receipt {
        bytes32 sessionId;
        uint128 amount;
        uint64 paidAt; // 0 = unpaid
    }

    /// @notice Everything an agent (or MCP tool) needs to decide whether it can pay.
    struct Budget {
        bool active;
        uint40 expiry;
        uint128 perTxCap;
        uint128 dailyRemaining;
        uint128 totalRemaining;
        uint256 ownerBalance;
        uint256 spendableNow; // min of all of the above; 0 when inactive
    }

    // -------------------------------------------------------------- constants

    bytes32 public constant PAYMENT_INTENT_TYPEHASH = keccak256(
        "PaymentIntent(bytes32 sessionId,address merchant,uint256 amount,bytes32 orderId,bytes32 nonce,uint64 deadline)"
    );

    /// @notice Sessions can't outlive this. Long-lived agent keys are a liability.
    uint256 public constant MAX_SESSION_DURATION = 90 days;

    // ------------------------------------------------------------------ state

    IERC20 public immutable token;

    /// @notice tUSD8 each owner holds in the vault (not yet spent or withdrawn).
    mapping(address owner => uint256) public balanceOf;
    /// @notice Bumped by `revokeAll`. Sessions opened under an older epoch are dead.
    mapping(address owner => uint32) public epochOf;
    /// @notice Number of sessions each owner has opened. Feeds the session id.
    mapping(address owner => uint256) public sessionCount;

    mapping(bytes32 sessionId => Session) private _sessions;
    mapping(bytes32 sessionId => mapping(address merchant => bool)) public isMerchantAllowed;
    mapping(bytes32 sessionId => mapping(bytes32 nonce => bool)) public nonceUsed;
    mapping(address merchant => mapping(bytes32 orderId => Receipt)) private _receipts;

    // ----------------------------------------------------------------- events

    event Deposited(address indexed owner, address indexed from, uint256 amount);
    event Withdrawn(address indexed owner, uint256 amount);
    event SessionOpened(
        bytes32 indexed sessionId,
        address indexed owner,
        address indexed agent,
        uint128 perTxCap,
        uint128 dailyCap,
        uint128 totalCap,
        uint40 expiry
    );
    event MerchantSet(bytes32 indexed sessionId, address indexed merchant, bool allowed);
    event SessionRevoked(bytes32 indexed sessionId, address indexed owner);
    event AllSessionsRevoked(address indexed owner, uint32 newEpoch);
    event Paid(
        bytes32 indexed sessionId,
        address indexed merchant,
        bytes32 indexed orderId,
        address owner,
        address agent,
        uint256 amount,
        bytes32 nonce
    );

    // ----------------------------------------------------------------- errors

    error ZeroAddress();
    error ZeroAmount();
    error InvalidCaps();
    error InvalidExpiry();
    error NotOwner();
    error UnknownSession();
    error BadSignature();
    error Revoked();
    error SessionExpired();
    error IntentExpired();
    error MerchantNotAllowed();
    error NonceUsed();
    error OrderAlreadyPaid();
    error OverPerTx();
    error OverDaily();
    error OverTotal();
    error InsufficientBalance();

    constructor(IERC20 token_) EIP712("Perault", "1") {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    // ------------------------------------------------------- owner: funds

    /// @notice Deposit `amount` you have approved to this vault.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
        emit Deposited(msg.sender, msg.sender, amount);
    }

    /// @notice Gasless deposit: `from` signs an EIP-3009 `ReceiveWithAuthorization` with
    ///         `to = address(this)`, anyone submits it, and the funds are credited to `from`.
    /// @dev Only this contract can redeem a ReceiveWithAuthorization made out to it, and the
    ///      credit always goes to the signer, so a relayer can't redirect the deposit.
    function depositWithAuthorization(
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC3009Receive(address(token)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, nonce, v, r, s
        );
        balanceOf[from] += amount;
        emit Deposited(from, msg.sender, amount);
    }

    /// @notice Withdraw unspent funds. Only the owner's own balance; agents have none.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender];
        if (amount > bal) revert InsufficientBalance();
        balanceOf[msg.sender] = bal - amount;
        emit Withdrawn(msg.sender, amount);
        token.safeTransfer(msg.sender, amount);
    }

    // ---------------------------------------------------- owner: sessions

    /// @notice Give `agent` a scoped budget over your vault balance.
    /// @param perTxCap  max amount of a single payment (must be > 0)
    /// @param dailyCap  max spent per UTC day (>= perTxCap)
    /// @param totalCap  max spent over the session's life (>= dailyCap)
    /// @param expiry    unix time the session dies; in the future, at most MAX_SESSION_DURATION away
    /// @param merchants initial allowlist; an empty list means the agent can pay no one yet
    function openSession(
        address agent,
        uint128 perTxCap,
        uint128 dailyCap,
        uint128 totalCap,
        uint40 expiry,
        address[] calldata merchants
    ) external returns (bytes32 sessionId) {
        if (agent == address(0)) revert ZeroAddress();
        if (perTxCap == 0 || perTxCap > dailyCap || dailyCap > totalCap) revert InvalidCaps();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_SESSION_DURATION) {
            revert InvalidExpiry();
        }

        sessionId = keccak256(abi.encode(block.chainid, address(this), msg.sender, sessionCount[msg.sender]++));
        _sessions[sessionId] = Session({
            owner: msg.sender,
            expiry: expiry,
            epoch: epochOf[msg.sender],
            revoked: false,
            agent: agent,
            day: _today(),
            perTxCap: perTxCap,
            dailyCap: dailyCap,
            totalCap: totalCap,
            spentTotal: 0,
            spentToday: 0
        });
        emit SessionOpened(sessionId, msg.sender, agent, perTxCap, dailyCap, totalCap, expiry);

        for (uint256 i = 0; i < merchants.length; i++) {
            _setMerchant(sessionId, merchants[i], true);
        }
    }

    /// @notice Add or remove a merchant from a session's allowlist.
    function setMerchant(bytes32 sessionId, address merchant, bool allowed) external {
        _onlyOwner(sessionId);
        _setMerchant(sessionId, merchant, allowed);
    }

    /// @notice Kill one session immediately. Cannot be undone.
    function revoke(bytes32 sessionId) external {
        _onlyOwner(sessionId);
        _sessions[sessionId].revoked = true;
        emit SessionRevoked(sessionId, msg.sender);
    }

    /// @notice Kill switch: every session you have opened so far dies immediately.
    function revokeAll() external {
        uint32 e = ++epochOf[msg.sender];
        emit AllSessionsRevoked(msg.sender, e);
    }

    // ---------------------------------------------------------- agent: pay

    /// @notice Settle a payment signed by a session's agent. Anyone can submit it.
    /// @dev Checks, then effects, then the token transfer; plus a reentrancy guard.
    function pay(PaymentIntent calldata intent, bytes calldata signature) external nonReentrant {
        bytes4 err = _check(intent, signature);
        if (err != bytes4(0)) {
            assembly {
                mstore(0, err)
                revert(0, 4)
            }
        }

        Session storage s = _sessions[intent.sessionId];
        uint128 amount = uint128(intent.amount); // safe: _check bounded it by perTxCap
        uint64 today = _today();
        if (s.day != today) {
            s.day = today;
            s.spentToday = 0;
        }
        s.spentToday += amount;
        s.spentTotal += amount;
        balanceOf[s.owner] -= amount;
        nonceUsed[intent.sessionId][intent.nonce] = true;
        _receipts[intent.merchant][intent.orderId] =
            Receipt({sessionId: intent.sessionId, amount: amount, paidAt: uint64(block.timestamp)});

        emit Paid(intent.sessionId, intent.merchant, intent.orderId, s.owner, s.agent, amount, intent.nonce);
        token.safeTransfer(intent.merchant, amount);
    }

    // ------------------------------------------------------------------ views

    /// @notice Dry-run of `pay`: returns the selector of the error `pay` would revert with,
    ///         or `bytes4(0)` if it would succeed right now. Facilitators use it for /verify.
    function preview(PaymentIntent calldata intent, bytes calldata signature) external view returns (bytes4) {
        return _check(intent, signature);
    }

    /// @notice The EIP-712 digest the agent signs for `intent`.
    function hashIntent(PaymentIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PAYMENT_INTENT_TYPEHASH,
                    intent.sessionId,
                    intent.merchant,
                    intent.amount,
                    intent.orderId,
                    intent.nonce,
                    intent.deadline
                )
            )
        );
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function getSession(bytes32 sessionId) external view returns (Session memory) {
        return _sessions[sessionId];
    }

    function receiptOf(address merchant, bytes32 orderId) external view returns (Receipt memory) {
        return _receipts[merchant][orderId];
    }

    function isActive(bytes32 sessionId) public view returns (bool) {
        Session storage s = _sessions[sessionId];
        return s.owner != address(0) && !s.revoked && s.epoch == epochOf[s.owner] && block.timestamp < s.expiry;
    }

    /// @notice What the session can spend right now, accounting for the daily reset.
    function budgetOf(bytes32 sessionId) external view returns (Budget memory b) {
        Session storage s = _sessions[sessionId];
        b.active = isActive(sessionId);
        b.expiry = s.expiry;
        b.perTxCap = s.perTxCap;
        uint128 spentToday = s.day == _today() ? s.spentToday : 0;
        b.dailyRemaining = s.dailyCap - spentToday;
        b.totalRemaining = s.totalCap - s.spentTotal;
        b.ownerBalance = balanceOf[s.owner];
        if (b.active) {
            uint256 m = b.perTxCap;
            if (b.dailyRemaining < m) m = b.dailyRemaining;
            if (b.totalRemaining < m) m = b.totalRemaining;
            if (b.ownerBalance < m) m = b.ownerBalance;
            b.spendableNow = m;
        }
    }

    // --------------------------------------------------------------- internal

    /// @dev Single source of truth for `pay` and `preview`. Order: authenticate first, then
    ///      session state, then intent state, then money.
    function _check(PaymentIntent calldata intent, bytes calldata signature) private view returns (bytes4) {
        Session storage s = _sessions[intent.sessionId];
        if (s.owner == address(0)) return UnknownSession.selector;
        if (!SignatureChecker.isValidSignatureNow(s.agent, hashIntent(intent), signature)) {
            return BadSignature.selector;
        }
        if (s.revoked || s.epoch != epochOf[s.owner]) return Revoked.selector;
        if (block.timestamp >= s.expiry) return SessionExpired.selector;
        if (block.timestamp > intent.deadline) return IntentExpired.selector;
        if (intent.amount == 0) return ZeroAmount.selector;
        if (!isMerchantAllowed[intent.sessionId][intent.merchant]) return MerchantNotAllowed.selector;
        if (nonceUsed[intent.sessionId][intent.nonce]) return NonceUsed.selector;
        if (_receipts[intent.merchant][intent.orderId].paidAt != 0) return OrderAlreadyPaid.selector;
        if (intent.amount > s.perTxCap) return OverPerTx.selector;
        uint256 spentToday = s.day == _today() ? s.spentToday : 0;
        if (spentToday + intent.amount > s.dailyCap) return OverDaily.selector;
        if (uint256(s.spentTotal) + intent.amount > s.totalCap) return OverTotal.selector;
        if (intent.amount > balanceOf[s.owner]) return InsufficientBalance.selector;
        return bytes4(0);
    }

    function _setMerchant(bytes32 sessionId, address merchant, bool allowed) private {
        if (merchant == address(0)) revert ZeroAddress();
        isMerchantAllowed[sessionId][merchant] = allowed;
        emit MerchantSet(sessionId, merchant, allowed);
    }

    function _onlyOwner(bytes32 sessionId) private view {
        address owner = _sessions[sessionId].owner;
        if (owner == address(0)) revert UnknownSession();
        if (owner != msg.sender) revert NotOwner();
    }

    function _today() private view returns (uint64) {
        return uint64(block.timestamp / 1 days);
    }
}
