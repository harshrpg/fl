const FlashLoan = artifacts.require("FlashLoan");
const { mainnet: addresses } = require('../addresses');

module.exports = function (deployer, _network, _addresses) {
  deployer.deploy(
    FlashLoan,
    addresses.kyber.kyberNetworkProxy,
    addresses.uniswap.router,
    addresses.tokens.weth,
    addresses.tokens.usdc,
    _addresses[0]
  );
};
