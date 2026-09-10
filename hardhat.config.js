require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("hardhat-contract-sizer");
require("dotenv").config();

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "0x" + "0".repeat(64);
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || ""; // Etherscan V2 — single key covers all chains (Ethereum, BSC, etc.)

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
      evmVersion: "cancun",
      outputSelection: {
        "*": {
          "*": ["storageLayout"],
        },
      },
    },
  },

  networks: {
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: false,
    },

    // ── Testnets ─────────────────────────────────────────
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
      chainId: 11155111,
      accounts: [PRIVATE_KEY],
      gas: "auto",
      gasPrice: "auto",
      timeout: 120000, // 2 minutes — Sepolia can be slow
    },

    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts: [PRIVATE_KEY],
      gas: "auto",
      gasPrice: "auto",
    },

    zkSyncSepolia: {
      url: process.env.ZKSYNC_SEPOLIA_RPC_URL || "https://sepolia.era.zksync.dev",
      chainId: 300,
      accounts: [PRIVATE_KEY],
      gas: "auto",
      gasPrice: "auto",
    },

    // ── Mainnets (uncomment when ready for production) ──
    // ethereum: {
    //   url: process.env.ETH_MAINNET_RPC_URL,
    //   chainId: 1,
    //   accounts: [PRIVATE_KEY],
    // },
    // bsc: {
    //   url: process.env.BSC_MAINNET_RPC_URL || "https://bsc-dataseed1.binance.org",
    //   chainId: 56,
    //   accounts: [PRIVATE_KEY],
    // },
    // zkSync: {
    //   url: process.env.ZKSYNC_MAINNET_RPC_URL || "https://mainnet.era.zksync.io",
    //   chainId: 324,
    //   accounts: [PRIVATE_KEY],
    // },
  },

  etherscan: {
    apiKey: ETHERSCAN_API_KEY, // Etherscan V2 — single key works across all supported networks (Ethereum + BSC + more)
    customChains: [
      {
        network: "zkSyncSepolia",
        chainId: 300,
        urls: {
          apiURL: "https://api-sepolia-era.zksync.network/api",
          browserURL: "https://sepolia.explorer.zksync.io",
        },
      },
    ],
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: process.env.CMC_API_KEY || "",
    outputFile: "gas-report.txt",
    noColors: true,
  },

  contractSizer: {
    alphaSort: true,
    runOnCompile: false,
    disambiguatePaths: false,
  },

  mocha: {
    timeout: 120000,
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
