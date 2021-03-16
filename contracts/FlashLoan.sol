pragma solidity ^0.5.0;
pragma experimental ABIEncoderV2;

import "@studydefi/money-legos/dydx/contracts/DydxFlashloanBase.sol";
import "@studydefi/money-legos/dydx/contracts/ICallee.sol";
import { KyberNetworkProxy as IKyberNetworkProxy } from "@studydefi/money-legos/kyber/contracts/KyberNetworkProxy.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import './interfaces/IUniswapV2Router02.sol';
import './interfaces/IWeth.sol';
contract FlashLoan is ICallee, DydxFlashloanBase {

    enum Direction {
        KyberToUniswap,
        UniswapToKyber
    }

    struct ContractInfo {
        Direction direction;
        uint256 repayAmount;
    }

    event NewArbitrage (Direction direction, uint profit, uint date);

    IKyberNetworkProxy kyber;
    IUniswapV2Router02 uniswap;
    IWeth weth;
    IERC20 usdc;
    address constant KYBER_ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address beneficiary;

    constructor(
        address _kyber,
        address _uniswap,
        address _weth,
        address _usdc,
        address _beneficiary
    ) public {
        kyber = IKyberNetworkProxy(_kyber);
        uniswap = IUniswapV2Router02(_uniswap);
        weth = IWeth(_weth);
        usdc = IERC20(_usdc);
        beneficiary = _beneficiary;
    }

    function callFunction(
        address sender, 
        Account.Info memory account, 
        bytes memory data
    ) public {
        ContractInfo memory contractInfo = abi.decode(data, (ContractInfo));
        uint256 balanceUsdc = usdc.balanceOf(address(this));
        if (contractInfo.direction == Direction.KyberToUniswap) {

            // Buy ETH from loanded USDC on Kyber
            usdc.approve(address(kyber), balanceUsdc);
            (uint expectedRate, ) = kyber.getExpectedRate(
                usdc,
                IERC20(KYBER_ETH_ADDRESS),
                balanceUsdc
            );
            kyber.swapTokenToEther(usdc, balanceUsdc, expectedRate);


            // Sell ETH on Uniswap
            address[] memory path = new address[](2);
            path[0] = address(weth); // source
            path[1] = address(usdc); // dest
            uint[] memory minOuts = uniswap.getAmountsOut(address(this).balance, path);
            uniswap.swapExactETHForTokens.value(address(this).balance)(minOuts[1], path, address(this), now);
        } else if (contractInfo.direction == Direction.UniswapToKyber) {
            // Buy ETH from loaned USDC on Uniswap
            usdc.approve(address(uniswap), balanceUsdc);
            address[] memory path = new address[](2);
            path[0] = address(usdc);
            path[1] = address(weth);
            uint[] memory minOuts = uniswap.getAmountsOut(balanceUsdc, path);
            uniswap.swapExactTokensForETH(balanceUsdc, minOuts[1], path, address(this), now);

            // Sell ETH on kyber
            (uint expectedRate, ) = kyber.getExpectedRate(
                IERC20(KYBER_ETH_ADDRESS),
                usdc,
                address(this).balance
            );
            kyber.swapEtherToToken.value(address(this).balance)(usdc, expectedRate);
        }

        require(
            usdc.balanceOf(address(this)) >= contractInfo.repayAmount,
            "Not Enough funds to repay loan"
        );

        uint profit = usdc.balanceOf(address(this)) - contractInfo.repayAmount;
        usdc.transfer(beneficiary, profit);

        emit NewArbitrage(contractInfo.direction, profit, now);
    }

    function initiateFlashloan(
        address _solo,
        address _token,
        uint256 _amount,
        Direction direction
    ) external {
        ISoloMargin solo = ISoloMargin(_solo);
        uint256 marketId = _getMarketIdFromTokenAddress(_solo, _token);
        uint256 repayAmount = _getRepaymentAmountInternal(_amount);
        IERC20(_token).approve(_solo, repayAmount);

        // 1. Withdraw $
        // 2. Call callFunction(...)
        // 3. Deposit back $
        Actions.ActionArgs[] memory operations = new Actions.ActionArgs[](3);
        operations[0] = _getWithdrawAction(marketId, _amount);
        operations[1] = _getCallAction(
            abi.encode(ContractInfo(
                {
                    direction: direction,
                    repayAmount: repayAmount
                }
            ))
        );
        operations[2] = _getDepositAction(marketId, repayAmount);

        Account.Info[] memory accountInfos = new Account.Info[](1);
        accountInfos[0] = _getAccountInfo();

        solo.operate(accountInfos, operations);
    }

    // fallback method
    function() external payable {}
    
}