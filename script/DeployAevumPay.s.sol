// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AevumPay, IERC20Metadata} from "../src/AevumPay.sol";

interface DeployVm {
    function envUint(string calldata name) external view returns (uint256);
    function startBroadcast(uint256 signingKey) external;
    function stopBroadcast() external;
}

contract DeployAevumPay {
    DeployVm private constant VM = DeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;

    function run() external returns (AevumPay pay) {
        require(block.chainid == 44005, "QDay Aevum testnet required");
        IERC20Metadata token = IERC20Metadata(TUSD8);
        require(token.decimals() == 6 && keccak256(bytes(token.symbol())) == keccak256("tUSD8"), "Unexpected tUSD8");

        VM.startBroadcast(VM.envUint("AEVUM_DEPLOYER_KEY"));
        pay = new AevumPay(token);
        VM.stopBroadcast();
    }
}
