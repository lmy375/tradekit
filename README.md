# tradekit

CLI and MCP server for trading ERC-20 tokens on Uniswap V3.

## Install

```bash
npm install -g tradekit
```

Or run directly:

```bash
npx tradekit
```

## Quick Start

```bash
# Create a wallet
tradekit wallet create

# Check balances
tradekit wallet view --chain base

# Buy ETH with 10 USDC
tradekit trade buy --quoteAmount 10

# Sell 0.01 ETH
tradekit trade sell --baseAmount 0.01
```

## Commands

### Wallet

```bash
tradekit wallet create     # Create a new encrypted wallet
tradekit wallet import     # Import from private key
tradekit wallet export     # Export private key
tradekit wallet view       # View address and balances
```

### Trade

```bash
tradekit trade buy         # Buy base token
tradekit trade sell        # Sell base token
```

Options:

| Flag | Description | Default |
|------|-------------|---------|
| `--chain <name>` | Chain name | `base` |
| `--base <token>` | Base token address or `ETH` | `ETH` |
| `--quote <token>` | Quote token address | USDC |
| `--baseAmount <n>` | Exact base token amount | - |
| `--quoteAmount <n>` | Exact quote token amount | - |
| `--slippage <bps>` | Slippage in basis points | `50` |

### MCP Server

```bash
tradekit mcp --pass <password>
```

Starts a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio, exposing the following tools:

| Tool | Description |
|------|-------------|
| `status` | Wallet address, balances, current price, recent trades |
| `buy` | Buy base token (by base or quote amount) |
| `sell` | Sell base token (by base or quote amount) |
| `price` | Current and historical prices (1d/1w/1m/1y) |
| `viewTx` | Look up transaction details by hash |

MCP config example (Claude Desktop):

```json
{
  "mcpServers": {
    "tradekit": {
      "command": "npx",
      "args": ["-y", "tradekit", "mcp"],
      "env": {
        "WALLET_PASS": "your-password"
      }
    }
  }
}
```

## Password

Wallet password is resolved in order:

1. `--pass <password>` flag
2. `WALLET_PASS` environment variable
3. Interactive prompt (not available in MCP mode)

## Supported Chains

| Chain | ID | Default Tokens |
|-------|----|---------------|
| `base` | 8453 | ETH / USDC |
| `ethereum` | 1 | ETH / USDC |
| `arbitrum` | 42161 | ETH / USDC |

## Configuration

Optional config file at `~/.tradekit/config.json`:

```json
{
  "chains": {
    "base": {
      "rpc": "https://your-rpc.com",
      "base": "0x...",
      "quote": "0x..."
    }
  }
}
```

All fields are optional and override built-in defaults.

## Data Storage

All data is stored in `~/.tradekit/`:

| File | Content |
|------|---------|
| `wallet.json` | Encrypted keystore |
| `config.json` | User configuration |
| `trade.csv` | Trade history |
| `server.log` | Logs |

## License

MIT
