require('dotenv').config();
const Web3 = require('web3');
const abis = require('./abis');
const FlashLoan = require('./build/contracts/FlashLoan.json');
const { mainnet: addresses } = require('./addresses');
const { ChainId, Token, TokenAmount, Pair, Fetcher , WETH } = require('@uniswap/sdk');
const web3 = new Web3(
    new Web3.providers.WebsocketProvider(process.env.INFURA_MAINNET_WS + process.env.INFIRA_MAINNET_PROJ_ID)
);

// wallet private key to sign transactions
const { address: admin } = web3.eth.accounts.wallet.add(process.env.PRIVATE_KEY);

const AMOUNT_ETH = 100;
const RECENT_ETH_PRICE = 1800;
const AMOUNT_ETH_WEI = web3.utils.toWei(AMOUNT_ETH.toString());
const AMOUNT_DAI_WEI = web3.utils.toWei((AMOUNT_ETH * RECENT_ETH_PRICE).toString());
const AMOUNT_USDC_DECIMAL = ((AMOUNT_ETH * RECENT_ETH_PRICE) * (10 ** 6)).toString();
const KYBER_ETH_ADD = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const DIRECTION = {
    KYBER_TO_UNISWAP: 0,
    UNISWP_TO_KYBER: 1
};
// Fetch Kyber contract from abi and contract address
const kyber = new web3.eth.Contract(
    abis.kyber.kyberNetworkProxy,
    addresses.kyber.kyberNetworkProxy
);

const init = async () => {
    const networkId = await web3.eth.net.getId(); // Chain ID [Mainnet: 1]
    const flashLoan = new web3.eth.Contract(
        FlashLoan.abi,
        FlashLoan.networks[networkId].address
    );

    const usdc = await new Token(ChainId.MAINNET, addresses.tokens.usdc, 6);
    const weth = await new Token(ChainId.MAINNET, addresses.tokens.weth, 18);
    // Fetch pair data from uniswap
    const usdcWeth = await Fetcher.fetchPairData(usdc, WETH[usdc.chainId]);

    web3.eth.subscribe('newBlockHeaders')
        .on('data', async block => {
            console.log(`Block received: # ${block.number}`);

            const kyberResults = await Promise.all([
                kyber.methods.getExpectedRate(
                    addresses.tokens.dai,
                    KYBER_ETH_ADD,
                    AMOUNT_USDC_DECIMAL
                ).call(),
                kyber.methods.getExpectedRate(
                    KYBER_ETH_ADD,
                    addresses.tokens.usdc,
                    AMOUNT_ETH_WEI
                ).call()
            ]);
            
            const kyberNormalized = {
                buy: parseFloat(1 / (kyberResults[0].expectedRate / (10 ** 18))),
                sell: parseFloat(kyberResults[1].expectedRate / (10 ** 18))
            };

            console.log('Kyber ETH/USDC');
            console.log(kyberNormalized);

            const uniswapResult = await Promise.all([
                usdcWeth.getOutputAmount(new TokenAmount(usdc, AMOUNT_USDC_DECIMAL)),
                usdcWeth.getOutputAmount(new TokenAmount(weth, AMOUNT_ETH_WEI)),
            ]);

            const uniswapNormalized = {
                buy: parseFloat( AMOUNT_USDC_DECIMAL / (uniswapResult[0][0].toExact() * (10 ** 6))),
                sell: parseFloat( uniswapResult[1][0].toExact() / AMOUNT_ETH)
            };

            console.log('Uniswap ETH/USDC');
            console.log(uniswapNormalized);

            const [tx1, tx2] = Object.keys(DIRECTION).map(direction => flashLoan.methods.initiateFlashloan(
                addresses.dydx.solo,
                addresses.tokens.usdc,
                AMOUNT_USDC_DECIMAL,
                DIRECTION[direction]
            ));
            const [gasPrice, gasCost1, gasCost2] = await Promise.all([
                web3.eth.getGasPrice(),
                tx1.estimateGas({from: admin}),
                tx2.estimateGas({from: admin}),
            ])

            const gasPrice = await web3.eth.getGasPrice();
            const txCost1 = parseInt(gasCost1) * parseInt(gasPrice);
            const txCost2 = parseInt(gasCost2) * parseInt(gasPrice);
            const currentEthPrice = (uniswapNormalized.buy + uniswapNormalized.sell) / 2;
            const profit1 = (parseInt(AMOUNT_ETH_WEI) / (10 ** 18)) * (uniswapNormalized.sell - kyberNormalized.buy) - (txCost1 / (10 ** 18) * currentEthPrice);
            const profit2 = (parseInt(AMOUNT_ETH_WEI) / (10 ** 18)) * (kyberNormalized.sell - uniswapNormalized.buy) - (txCost2 / (10 ** 18) * currentEthPrice);
            if(profit1 > 0) {
                console.log('Arb opportunity found!');
                console.log(`Buy ETH on Kyber at ${kyberNormalized.buy} dai`);
                console.log(`Sell ETH on Uniswap at ${uniswapNormalized.sell} dai`);
                console.log(`Expected profit: ${profit1} dai`);
                const data = tx1.encodeABI();
                const txData = {
                    from: admin,
                    to: flashLoan.options.address,
                    data,
                    gas: gasCost1,
                    gasPrice
                }
                const receipt = await web3.eth.sendTransaction(txData);
                console.log(`Tx Hash: ${receipt.transactionHash}`);
            } else if (profit2 > 0) {
                console.log('Arb opportunity found!');
                console.log(`Buy ETH from Uniswap at ${uniswapNormalized.buy} dai`);
                console.log(`Sell ETH from Kyber at ${kyberNormalized.sell} dai`);
                console.log(`Expected profit: ${profit2} dai`);
                const data = tx2.encodeABI();
                const txData = {
                    from: admin,
                    to: flashLoan.options.address,
                    data,
                    gas: gasCost2,
                    gasPrice
                }
                const receipt = await web3.eth.sendTransaction(txData);
                console.log(`Tx Hash: ${receipt.transactionHash}`);
            } else {
                console.log('No Arb opportunity found yet');
            }
        });
};
init();