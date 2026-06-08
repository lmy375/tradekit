import { useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Loader,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  getHoldings,
  postQuote,
  postTrade,
  type PageProps,
  type QuoteResult,
} from "../api";

export function Trade({ status, onStatusChange }: PageProps) {
  const [chain, setChain] = useState<string>(status.activeChain);
  const [direction, setDirection] = useState<"buy" | "sell">("buy");
  const [base, setBase] = useState("ETH");
  const [quote, setQuote] = useState("USDC");
  const [amount, setAmount] = useState<string>("10");
  const [slippageBps, setSlippageBps] = useState<number | string>(50);
  const [simulate, setSimulate] = useState(true);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [busy, setBusy] = useState<"quote" | "trade" | null>(null);

  // Available balances on the selected chain — used to populate the "Max" button and
  // give the user context about what they have to spend. `balancesRefresh` bumps to
  // force a re-fetch after a real (non-simulate) trade lands.
  const [balances, setBalances] = useState<{ symbol: string; amount: string }[] | null>(null);
  const [balancesRefresh, setBalancesRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setBalances(null);
    getHoldings({ chains: [chain] })
      .then((r) => {
        if (!active) return;
        const rep = r.reports.find((x) => x.chain === chain);
        setBalances(
          rep
            ? rep.balances
                .filter((b) => parseFloat(b.amount) > 0)
                .map((b) => ({ symbol: b.symbol, amount: b.amount }))
            : [],
        );
      })
      .catch(() => active && setBalances([]));
    return () => {
      active = false;
    };
  }, [chain, status.activeAccount, balancesRefresh]);

  // Which token's balance does this trade consume?  buy → quote token; sell → base token.
  const inputSymbol = direction === "buy" ? quote.toUpperCase() : base.toUpperCase();
  const inputBalance = balances?.find(
    (b) => b.symbol.toUpperCase() === inputSymbol || (inputSymbol === "ETH" && b.symbol.toUpperCase() === "ETH"),
  );

  async function run(kind: "quote" | "trade") {
    setBusy(kind);
    setResult(null);
    try {
      const body: Record<string, unknown> = {
        chain,
        direction,
        base,
        quote,
        slippageBps: Number(slippageBps),
      };
      if (direction === "buy") body.quoteAmount = amount;
      else body.baseAmount = amount;
      const fn = kind === "quote" ? postQuote : postTrade;
      if (kind === "trade") body.simulate = simulate;
      if (kind === "trade" && note.trim()) body.note = note.trim();
      const r = await fn(body);
      setResult(r.result);
      if (!simulate && kind === "trade" && r.result.txHash) {
        notifications.show({
          color: "green",
          message: `tx submitted: ${r.result.txHash.slice(0, 16)}…`,
        });
        // Refresh balances panel + header status so the user sees the new wallet
        // state immediately. The counter bump forces the useEffect to re-fetch
        // without depending on the state-value-changed equality.
        onStatusChange?.();
        setBalancesRefresh((n) => n + 1);
      }
    } catch (e) {
      const err = e as Error & { code?: string };
      notifications.show({ color: "red", title: err.code ?? "Error", message: err.message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Stack>
      <Card withBorder>
        <Group align="end" wrap="wrap">
          <Select
            label="Chain"
            data={status.chains}
            value={chain}
            onChange={(v) => v && setChain(v)}
            w={120}
          />
          <Stack gap={2}>
            <Text size="xs" c="dimmed">Direction</Text>
            <SegmentedControl
              value={direction}
              onChange={(v) => setDirection(v as "buy" | "sell")}
              data={[
                { value: "buy", label: "Buy" },
                { value: "sell", label: "Sell" },
              ]}
              size="xs"
            />
          </Stack>
          <TextInput label="Base" value={base} onChange={(e) => setBase(e.currentTarget.value)} w={100} />
          <Tooltip label="Swap base ↔ quote and flip direction" withArrow>
            <ActionIcon
              variant="default"
              size="lg"
              aria-label="Swap base and quote"
              onClick={() => {
                // Swap the pair AND invert direction so the semantics stay sensible:
                // "buy ETH with USDC" becomes "sell USDC for ETH" in the user's head
                // even though mechanically the tokens move the same way.
                setBase(quote);
                setQuote(base);
                setDirection((d) => (d === "buy" ? "sell" : "buy"));
              }}
            >
              ↔
            </ActionIcon>
          </Tooltip>
          <TextInput
            label="Quote"
            value={quote}
            onChange={(e) => setQuote(e.currentTarget.value)}
            w={100}
          />
          <Stack gap={2} style={{ flex: 1, minWidth: 200 }}>
            <Group gap="xs" justify="space-between">
              <Text size="xs" c="dimmed">
                {direction === "buy" ? `Quote amount (${quote.toUpperCase()})` : `Base amount (${base.toUpperCase()})`}
              </Text>
              {inputBalance && (
                <Text size="xs" c="dimmed">
                  bal: <Code fz="xs">{inputBalance.amount}</Code>{" "}
                  <Tooltip label="Use full balance (auto-reserves gas on native)" withArrow>
                    <Badge
                      style={{ cursor: "pointer" }}
                      variant="light"
                      onClick={() => setAmount("max")}
                    >
                      max
                    </Badge>
                  </Tooltip>
                </Text>
              )}
            </Group>
            <TextInput
              value={amount}
              onChange={(e) => setAmount(e.currentTarget.value)}
              placeholder='decimal amount or "max"'
            />
          </Stack>
          <NumberInput
            label="Slippage (bps)"
            value={slippageBps}
            onChange={setSlippageBps}
            w={120}
            min={1}
            max={5000}
          />
          <TextInput
            label="Note (optional)"
            placeholder="campaign tag, intent…"
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            w={180}
          />
        </Group>
        <Group mt="md" justify="space-between">
          <Switch
            label="Simulate (dry-run; no tx sent)"
            checked={simulate}
            onChange={(e) => setSimulate(e.currentTarget.checked)}
          />
          <Group>
            <Button variant="default" onClick={() => run("quote")} loading={busy === "quote"}>
              Quote only
            </Button>
            <Button color={simulate ? "blue" : "red"} onClick={() => run("trade")} loading={busy === "trade"}>
              {simulate ? "Simulate trade" : "Submit trade"}
            </Button>
          </Group>
        </Group>
        {balances === null && (
          <Group mt="xs" gap="xs">
            <Loader size="xs" />
            <Text size="xs" c="dimmed">Loading balances on {chain}…</Text>
          </Group>
        )}
      </Card>

      {result && <ResultCard r={result} />}
    </Stack>
  );
}

function ResultCard({ r }: { r: QuoteResult }) {
  const sizePct = r.balanceFraction != null ? (r.balanceFraction * 100).toFixed(1) : null;
  const sim = r.simulation;
  const exceedsBalance = r.balanceFraction != null && r.balanceFraction > 1;
  return (
    <Card withBorder>
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <Badge color={r.ok ? "green" : "red"}>{r.simulated ? "SIM" : r.status ?? "SENT"}</Badge>
          <Text fw={600}>
            {r.direction.toUpperCase()} {r.baseAmount} {r.baseSymbol} ← {r.quoteAmount} {r.quoteSymbol}
          </Text>
        </Group>
        <Badge variant="light">{r.aggregator}</Badge>
      </Group>
      <Stack gap={4}>
        <Text size="sm">
          Price: <Code>{r.price}</Code> {r.quoteSymbol}/{r.baseSymbol}
        </Text>
        {r.estimatedUsd != null && <Text size="sm">USD value: ~${r.estimatedUsd.toFixed(2)}</Text>}
        {sizePct && parseFloat(sizePct) >= 50 && (
          <Alert
            color={exceedsBalance ? "red" : parseFloat(sizePct) > 99 ? "yellow" : "yellow"}
            title={`Trade size: ${sizePct}% of input balance${exceedsBalance ? " — EXCEEDS balance!" : ""}`}
            mt="xs"
          >
            Double-check before submitting.
          </Alert>
        )}
        {sim && (
          <Alert
            color={sim.ok ? "green" : "red"}
            title={sim.ok ? "Simulation OK" : "Simulation would REVERT"}
            mt="xs"
          >
            Gas: <Code>{sim.gas}</Code> (~{sim.gasCostNative} native){" "}
            {!sim.ok && sim.revertReason && (
              <>
                <br />
                Reason: <Code>{sim.revertReason.slice(0, 200)}</Code>
              </>
            )}
          </Alert>
        )}
        {r.txHash && (
          <Text size="sm" mt="xs">
            Tx: <Code>{r.txHash}</Code>
          </Text>
        )}
      </Stack>
    </Card>
  );
}
