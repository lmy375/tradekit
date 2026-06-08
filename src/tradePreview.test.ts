// Iter608: unit tests for computePreviewMetrics — the pure math core of the
// trade preview feature. The orchestrator (previewTrade) needs HTTP and is
// covered by smoke tests; these unit tests pin the gas %, slippage cushion,
// balance fraction, and USD valuation math against concrete inputs.

import { describe, it, expect } from "vitest";
import { computePreviewMetrics } from "./tradePreview.js";

describe("computePreviewMetrics (iter608)", () => {
  it("happy path: 100 USDC → 0.025 ETH at $3000/ETH gives a coherent preview", () => {
    const m = computePreviewMetrics({
      amountIn: 100_000_000n, // 100 USDC (6 dec)
      amountOut: 25_000_000_000_000_000n, // 0.025 ETH (18 dec)
      amountOutMinimum: 24_750_000_000_000_000n, // 0.02475 (100 bps slippage)
      inDecimals: 6,
      outDecimals: 18,
      inputPriceUsd: 1,    // USDC ≈ $1
      outputPriceUsd: 3000, // ETH = $3000
      nativeUsdPrice: 3000,
      walletBalance: 500_000_000n, // 500 USDC
      currentAllowance: 1_000_000_000n, // 1000 USDC allowance — sufficient
      isNativeIn: false,
      gas: 300_000n,
      gasPriceWei: 1_000_000_000n, // 1 gwei
    });
    expect(m.amountIn).toBe("100");
    expect(m.amountOut).toBe("0.025");
    expect(m.amountOutMinimum).toBe("0.02475");
    expect(m.inputUsd).toBe(100);
    expect(m.outputUsd).toBe(75);
    expect(m.outputUsdFloor).toBe(74.25);
    expect(m.slippageCushionBps).toBe(100); // 1% slippage = 100 bps
    expect(m.effectivePrice).toBe(0.00025);
    expect(m.walletBalance).toBe("500");
    expect(m.balanceFractionPct).toBe(20); // 100/500 = 20%
    expect(m.currentAllowance).toBe("1000");
    expect(m.hasSufficientAllowance).toBe(true);
    // Gas: 300000 × 1 gwei = 3e14 wei = 0.0003 ETH ≈ $0.90 → 0.9% of $100 input.
    expect(m.estimatedGasNative).toBe("0.0003");
    expect(m.estimatedGasUsd).toBeCloseTo(0.9, 5);
    expect(m.gasPctOfInput).toBeCloseTo(0.9, 5);
  });

  it("native input: currentAllowance is null and hasSufficientAllowance is true", () => {
    const m = computePreviewMetrics({
      amountIn: 1_000_000_000_000_000_000n,
      amountOut: 3_000_000_000n,
      amountOutMinimum: 2_970_000_000n,
      inDecimals: 18,
      outDecimals: 6,
      inputPriceUsd: 3000,
      outputPriceUsd: 1,
      nativeUsdPrice: 3000,
      walletBalance: 2_000_000_000_000_000_000n,
      currentAllowance: null,
      isNativeIn: true,
      gas: 200_000n,
      gasPriceWei: 1_000_000_000n,
    });
    expect(m.currentAllowance).toBeNull();
    expect(m.hasSufficientAllowance).toBe(true); // native always sufficient (no approve needed)
  });

  it("insufficient allowance: hasSufficientAllowance=false signals approve is needed", () => {
    const m = computePreviewMetrics({
      amountIn: 1000n,
      amountOut: 500n,
      amountOutMinimum: 495n,
      inDecimals: 0,
      outDecimals: 0,
      inputPriceUsd: 1,
      outputPriceUsd: 1,
      nativeUsdPrice: 3000,
      walletBalance: 2000n,
      currentAllowance: 500n, // less than amountIn=1000
      isNativeIn: false,
      gas: 0n,
      gasPriceWei: 0n,
    });
    expect(m.hasSufficientAllowance).toBe(false);
    expect(m.currentAllowance).toBe("500");
  });

  it("infinite allowance: currentAllowance is 'infinite' and sufficiency is true", () => {
    const MAX = (1n << 256n) - 1n;
    const m = computePreviewMetrics({
      amountIn: 1000n,
      amountOut: 1n,
      amountOutMinimum: 1n,
      inDecimals: 0,
      outDecimals: 0,
      inputPriceUsd: null,
      outputPriceUsd: null,
      nativeUsdPrice: null,
      walletBalance: 2000n,
      currentAllowance: MAX,
      isNativeIn: false,
      gas: 0n,
      gasPriceWei: 0n,
    });
    expect(m.currentAllowance).toBe("infinite");
    expect(m.hasSufficientAllowance).toBe(true);
  });

  it("slippage cushion: 50 bps requested → ~50 bps in result", () => {
    // amountOut=10000, amountOutMin=9950 → diff/out = 50/10000 = 50 bps.
    const m = computePreviewMetrics({
      amountIn: 1000n,
      amountOut: 10000n,
      amountOutMinimum: 9950n,
      inDecimals: 0,
      outDecimals: 0,
      inputPriceUsd: 1,
      outputPriceUsd: 1,
      nativeUsdPrice: null,
      walletBalance: 1000n,
      currentAllowance: 1000n,
      isNativeIn: false,
      gas: 0n,
      gasPriceWei: 0n,
    });
    expect(m.slippageCushionBps).toBe(50);
  });

  it("slippage cushion guards zero amountOut (division-by-zero edge)", () => {
    const m = computePreviewMetrics({
      amountIn: 1000n,
      amountOut: 0n,
      amountOutMinimum: 0n,
      inDecimals: 0,
      outDecimals: 0,
      inputPriceUsd: null,
      outputPriceUsd: null,
      nativeUsdPrice: null,
      walletBalance: 1000n,
      currentAllowance: 1000n,
      isNativeIn: false,
      gas: 0n,
      gasPriceWei: 0n,
    });
    expect(m.slippageCushionBps).toBe(0);
  });

  it("null prices: inputUsd/outputUsd/estimatedGasUsd/gasPctOfInput all null", () => {
    const m = computePreviewMetrics({
      amountIn: 100n,
      amountOut: 200n,
      amountOutMinimum: 198n,
      inDecimals: 0,
      outDecimals: 0,
      inputPriceUsd: null,
      outputPriceUsd: null,
      nativeUsdPrice: null,
      walletBalance: 1000n,
      currentAllowance: 1000n,
      isNativeIn: false,
      gas: 100_000n,
      gasPriceWei: 1_000_000_000n,
    });
    expect(m.inputUsd).toBeNull();
    expect(m.outputUsd).toBeNull();
    expect(m.outputUsdFloor).toBeNull();
    expect(m.estimatedGasUsd).toBeNull();
    expect(m.gasPctOfInput).toBeNull();
    // Non-USD math still works.
    expect(m.slippageCushionBps).toBe(100); // (200-198)/200 = 100 bps
    expect(m.balanceFractionPct).toBe(10); // 100/1000
    expect(m.estimatedGasNative).not.toBeNull(); // gas in ETH units still computable
  });

  it("balance fraction: 100% means spending the entire balance", () => {
    const m = computePreviewMetrics({
      amountIn: 1000n,
      amountOut: 999n,
      amountOutMinimum: 990n,
      inDecimals: 0,
      outDecimals: 0,
      inputPriceUsd: 1,
      outputPriceUsd: 1,
      nativeUsdPrice: 3000,
      walletBalance: 1000n, // exactly the amount being spent
      currentAllowance: 1000n,
      isNativeIn: false,
      gas: 0n,
      gasPriceWei: 0n,
    });
    expect(m.balanceFractionPct).toBe(100);
  });

  it("balance fraction guards zero balance (division-by-zero edge)", () => {
    const m = computePreviewMetrics({
      amountIn: 1000n,
      amountOut: 999n,
      amountOutMinimum: 990n,
      inDecimals: 0,
      outDecimals: 0,
      inputPriceUsd: 1,
      outputPriceUsd: 1,
      nativeUsdPrice: 3000,
      walletBalance: 0n, // empty wallet
      currentAllowance: 1000n,
      isNativeIn: false,
      gas: 0n,
      gasPriceWei: 0n,
    });
    expect(m.balanceFractionPct).toBe(0);
  });

  it("gas % of input: 5% threshold sanity (small trade, big gas)", () => {
    // $10 trade, $1 gas → 10% — way over the 5% noise threshold.
    const m = computePreviewMetrics({
      amountIn: 10_000_000n, // 10 USDC
      amountOut: 1n,
      amountOutMinimum: 1n,
      inDecimals: 6,
      outDecimals: 0,
      inputPriceUsd: 1,
      outputPriceUsd: 3000,
      nativeUsdPrice: 3000,
      walletBalance: 100_000_000n,
      currentAllowance: 100_000_000n,
      isNativeIn: false,
      // gas = 333_333 × 1 gwei = 3.33e14 wei = 0.000333 ETH ≈ $1
      gas: 333_333n,
      gasPriceWei: 1_000_000_000n,
    });
    expect(m.gasPctOfInput).toBeGreaterThan(5);
    expect(m.gasPctOfInput).toBeLessThan(15);
  });

  it("zero gas: estimatedGasNative is null (gas was never quoted)", () => {
    const m = computePreviewMetrics({
      amountIn: 1000n,
      amountOut: 999n,
      amountOutMinimum: 990n,
      inDecimals: 0,
      outDecimals: 0,
      inputPriceUsd: 1,
      outputPriceUsd: 1,
      nativeUsdPrice: 3000,
      walletBalance: 1000n,
      currentAllowance: 1000n,
      isNativeIn: false,
      gas: 0n,
      gasPriceWei: 0n,
    });
    expect(m.estimatedGasNative).toBeNull();
    expect(m.estimatedGasUsd).toBeNull();
    expect(m.gasPctOfInput).toBeNull();
  });

  it("effective price computes amountOut/amountIn correctly", () => {
    // 100 USDC → 0.025 ETH means 0.00025 ETH/USDC.
    const m = computePreviewMetrics({
      amountIn: 100_000_000n,
      amountOut: 25_000_000_000_000_000n,
      amountOutMinimum: 24_750_000_000_000_000n,
      inDecimals: 6,
      outDecimals: 18,
      inputPriceUsd: 1,
      outputPriceUsd: 3000,
      nativeUsdPrice: 3000,
      walletBalance: 1_000_000_000n,
      currentAllowance: 1_000_000_000n,
      isNativeIn: false,
      gas: 100_000n,
      gasPriceWei: 1_000_000_000n,
    });
    expect(m.effectivePrice).toBe(0.00025);
  });
});
