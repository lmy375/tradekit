import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Box,
  Card,
  Group,
  Loader,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import {
  getBacktest,
  getBacktests,
  getBacktestComparison,
  getBacktestComparisons,
  type BacktestComparisonDetail,
  type BacktestComparisonSummary,
  type BacktestRiskMetrics,
  type BacktestRunDetail,
  type BacktestRunSummary,
  type PageProps,
} from "../api";

function usd(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(digits)}`;
}

function signedUsd(n: number): string {
  return `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;
}

function plColor(n: number): string {
  return n >= 0 ? "teal" : "red";
}

/** Strategy + hold equity curves overlaid on ONE y-scale — the whole
 *  point of persisting both is that different scales aren't
 *  comparable. Strategy = solid, hold = dashed dimmed. */
function DualCurveSvg({ strategy, hold }: { strategy: BacktestRiskMetrics | null; hold: BacktestRiskMetrics | null }) {
  const sPts = strategy?.curve ?? [];
  const hPts = hold?.curve ?? [];
  if (sPts.length < 2 && hPts.length < 2) return null;
  const w = 640, h = 140, pad = 4;
  const all = [...sPts, ...hPts].map((p) => p.equityUsd);
  const min = Math.min(...all), max = Math.max(...all);
  const span = max - min || 1;
  const toPoly = (pts: Array<{ ts: string; equityUsd: number }>) =>
    pts
      .map((p, i) => {
        const x = pad + (i / (pts.length - 1)) * (w - 2 * pad);
        const y = h - pad - ((p.equityUsd - min) / span) * (h - 2 * pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  const up = sPts.length >= 2 ? sPts[sPts.length - 1].equityUsd >= sPts[0].equityUsd : true;
  return (
    <Box>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 140 }} preserveAspectRatio="none">
        {hPts.length >= 2 && (
          <polyline
            points={toPoly(hPts)}
            fill="none"
            stroke="var(--mantine-color-gray-6)"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        )}
        {sPts.length >= 2 && (
          <polyline
            points={toPoly(sPts)}
            fill="none"
            stroke={up ? "var(--mantine-color-teal-5)" : "var(--mantine-color-red-5)"}
            strokeWidth={1.5}
          />
        )}
      </svg>
      <Group gap="lg">
        <Text size="xs" c="dimmed">
          <Text component="span" c={up ? "teal" : "red"}>━</Text> strategy
        </Text>
        <Text size="xs" c="dimmed">┄ hold (frictionless)</Text>
      </Group>
    </Box>
  );
}

function MetricRow({ label, m }: { label: string; m: BacktestRiskMetrics }) {
  return (
    <Table.Tr>
      <Table.Td><Text size="xs" fw={600}>{label}</Text></Table.Td>
      <Table.Td>
        <Text size="xs" ff="monospace" c={m.maxDrawdownPct > 0 ? "red.4" : "dimmed"}>
          {m.maxDrawdownPct > 0 ? `−${m.maxDrawdownPct.toFixed(1)}% (${usd(-m.maxDrawdownUsd)})` : "0%"}
        </Text>
      </Table.Td>
      <Table.Td><Text size="xs" ff="monospace">{m.volatilityPctAnnual != null ? `${m.volatilityPctAnnual.toFixed(1)}%` : "—"}</Text></Table.Td>
      <Table.Td><Text size="xs" ff="monospace">{m.sharpe != null ? m.sharpe.toFixed(2) : "—"}</Text></Table.Td>
      <Table.Td><Text size="xs" ff="monospace">{m.timeInMarketPct.toFixed(0)}%</Text></Table.Td>
      <Table.Td><Text size="xs" ff="monospace" c={plColor(m.returnPct)}>{m.returnPct >= 0 ? "+" : ""}{m.returnPct.toFixed(2)}%</Text></Table.Td>
    </Table.Tr>
  );
}

function RunDetail({ id }: { id: number }) {
  const [run, setRun] = useState<BacktestRunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    getBacktest(id)
      .then((r) => setRun(r.run))
      .catch(() => setRun(null))
      .finally(() => setLoading(false));
  }, [id]);
  if (loading) return <Loader size="sm" />;
  if (!run) return <Text size="sm" c="dimmed">Failed to load run #{id}.</Text>;

  const m = run.metrics?.metrics ?? null;
  const hm = run.metrics?.holdMetrics ?? null;
  const fills = run.fires.filter((f) => (f.multiAction ?? f.action) === "fill");
  const friction = fills.reduce((s, f) => s + (f.slippageCostUsd ?? 0) + (f.gasCostUsd ?? 0), 0);

  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" mb={4}>
        <Title order={6}>
          Run #{run.id} · {run.strategy_type} · {run.base_symbol}/{run.quote_symbol} · {run.chain}
        </Title>
        <Text size="xs" c="dimmed" ff="monospace">
          {run.window_start.slice(0, 10)} → {run.window_end.slice(0, 10)} · {run.points} pts
        </Text>
      </Group>

      <Group gap="xl" mb="xs">
        <Text size="sm">PnL <Text component="span" fw={700} ff="monospace" c={plColor(run.pnl_usd)}>{signedUsd(run.pnl_usd)}</Text></Text>
        <Text size="sm">hold <Text component="span" ff="monospace" c="dimmed">{signedUsd(run.hold_pnl_usd)}</Text></Text>
        <Text size="sm">vs hold <Text component="span" fw={700} ff="monospace" c={plColor(run.vs_hold_usd)}>{signedUsd(run.vs_hold_usd)}</Text></Text>
        {friction > 0 && <Text size="sm" c="dimmed">friction <Text component="span" ff="monospace">{usd(friction)}</Text></Text>}
      </Group>

      <DualCurveSvg strategy={m} hold={hm} />

      {(m || hm) && (
        <Table mt="xs" withRowBorders={false} verticalSpacing={2}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th><Text size="xs" c="dimmed"></Text></Table.Th>
              <Table.Th><Text size="xs" c="dimmed">max DD</Text></Table.Th>
              <Table.Th><Text size="xs" c="dimmed">vol/yr</Text></Table.Th>
              <Table.Th><Text size="xs" c="dimmed">sharpe</Text></Table.Th>
              <Table.Th><Text size="xs" c="dimmed">in-market</Text></Table.Th>
              <Table.Th><Text size="xs" c="dimmed">return</Text></Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {m && <MetricRow label="strategy" m={m} />}
            {hm && <MetricRow label="hold" m={hm} />}
          </Table.Tbody>
        </Table>
      )}

      {fills.length > 0 && (
        <>
          <Text size="xs" c="dimmed" mt="xs" mb={2}>Fills ({fills.length}{fills.length > 30 ? ", showing 30" : ""})</Text>
          <Table withRowBorders={false} verticalSpacing={1}>
            <Table.Tbody>
              {fills.slice(0, 30).map((f, i) => (
                <Table.Tr key={i}>
                  <Table.Td><Text size="xs" ff="monospace" c="dimmed">{f.ts.slice(0, 16).replace("T", " ")}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">${f.priceUsd.toFixed(2)}</Text></Table.Td>
                  <Table.Td><Text size="xs" c="dimmed">{f.strategyId ? `[${f.strategyId}] ` : ""}{f.note ?? ""}</Text></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}

      {run.notes && <Text size="xs" c="dimmed" mt="xs">{run.notes}</Text>}
    </Card>
  );
}

function ComparisonDetail({ id }: { id: number }) {
  const [cmp, setCmp] = useState<BacktestComparisonDetail | null>(null);
  useEffect(() => {
    getBacktestComparison(id).then((r) => setCmp(r.comparison)).catch(() => setCmp(null));
  }, [id]);
  if (!cmp) return null;
  return (
    <Card withBorder padding="sm">
      <Title order={6} mb={4}>Comparison #{cmp.id} "{cmp.name}" · {cmp.base_symbol}/{cmp.quote_symbol}</Title>
      <Table withRowBorders={false} verticalSpacing={2}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th><Text size="xs" c="dimmed">scenario</Text></Table.Th>
            <Table.Th><Text size="xs" c="dimmed">PnL</Text></Table.Th>
            <Table.Th><Text size="xs" c="dimmed">vs hold</Text></Table.Th>
            <Table.Th><Text size="xs" c="dimmed">max DD</Text></Table.Th>
            <Table.Th><Text size="xs" c="dimmed">fires</Text></Table.Th>
            <Table.Th><Text size="xs" c="dimmed">run</Text></Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {cmp.scenarios.map((s, i) => (
            <Table.Tr key={s.runId}>
              <Table.Td>
                <Text size="xs" fw={i === cmp.winner_idx ? 700 : 400}>
                  {i === cmp.winner_idx ? "★ " : ""}{s.scenarioName}
                </Text>
              </Table.Td>
              <Table.Td><Text size="xs" ff="monospace" c={plColor(s.pnlUsd)}>{signedUsd(s.pnlUsd)}</Text></Table.Td>
              <Table.Td><Text size="xs" ff="monospace" c={plColor(s.vsHoldUsd)}>{signedUsd(s.vsHoldUsd)}</Text></Table.Td>
              <Table.Td><Text size="xs" ff="monospace" c="red.4">{s.maxDrawdownPct != null ? `−${s.maxDrawdownPct.toFixed(1)}%` : "—"}</Text></Table.Td>
              <Table.Td><Text size="xs" ff="monospace">{s.fireCount}</Text></Table.Td>
              <Table.Td><Text size="xs" ff="monospace" c="dimmed">#{s.runId}</Text></Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  );
}

export function Backtests({ status: _status }: PageProps) {
  const [runs, setRuns] = useState<BacktestRunSummary[] | null>(null);
  const [comparisons, setComparisons] = useState<BacktestComparisonSummary[]>([]);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<number | null>(null);
  const [selectedCmp, setSelectedCmp] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const [r, c] = await Promise.all([
      getBacktests({ strategyType: typeFilter ?? undefined, limit: 100 }).catch(() => null),
      getBacktestComparisons().catch(() => null),
    ]);
    setRuns(r?.runs ?? []);
    setComparisons(c?.comparisons ?? []);
  }, [typeFilter]);
  useEffect(() => { refresh(); }, [refresh]);

  if (runs === null) return <Loader size="sm" />;

  return (
    <Stack>
      <Group justify="space-between">
        <Text c="dimmed" size="sm">
          Backtest runs persist from <Text component="span" ff="monospace">tradekit backtest …</Text> (CLI/MCP).
          Risk metrics + equity curves are stored per run; the series itself is not.
        </Text>
        <Select
          size="xs"
          placeholder="all types"
          clearable
          data={["order", "schedule", "playbook", "rebalance"]}
          value={typeFilter}
          onChange={setTypeFilter}
        />
      </Group>

      {runs.length === 0 ? (
        <Text c="dimmed">No backtest runs yet — try <Text component="span" ff="monospace">tradekit backtest schedule --side buy --every 1d …</Text></Text>
      ) : (
        <Card withBorder padding="xs">
          <Table highlightOnHover verticalSpacing={2}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th><Text size="xs" c="dimmed">id</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">type</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">pair</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">window</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">fires</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">PnL</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">vs hold</Text></Table.Th>
                <Table.Th></Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {runs.map((r) => (
                <Table.Tr
                  key={r.id}
                  style={{ cursor: "pointer" }}
                  bg={selectedRun === r.id ? "var(--mantine-color-dark-6)" : undefined}
                  onClick={() => setSelectedRun(selectedRun === r.id ? null : r.id)}
                >
                  <Table.Td><Text size="xs" ff="monospace">#{r.id}</Text></Table.Td>
                  <Table.Td><Badge size="xs" variant="light">{r.strategy_type}</Badge></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{r.base_symbol}/{r.quote_symbol}</Text></Table.Td>
                  <Table.Td><Text size="xs" c="dimmed" ff="monospace">{r.window_start.slice(0, 10)}→{r.window_end.slice(5, 10)}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{r.fire_count}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace" c={plColor(r.pnl_usd)}>{signedUsd(r.pnl_usd)}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace" c={plColor(r.vs_hold_usd)}>{signedUsd(r.vs_hold_usd)}</Text></Table.Td>
                  <Table.Td>{r.has_metrics && <Badge size="xs" variant="dot" color="teal">risk</Badge>}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      {selectedRun != null && <RunDetail id={selectedRun} />}

      {comparisons.length > 0 && (
        <Card withBorder padding="xs">
          <Title order={6} mb={4}>Comparisons</Title>
          <Table highlightOnHover verticalSpacing={2}>
            <Table.Tbody>
              {comparisons.map((c) => (
                <Table.Tr
                  key={c.id}
                  style={{ cursor: "pointer" }}
                  bg={selectedCmp === c.id ? "var(--mantine-color-dark-6)" : undefined}
                  onClick={() => setSelectedCmp(selectedCmp === c.id ? null : c.id)}
                >
                  <Table.Td><Text size="xs" ff="monospace">#{c.id}</Text></Table.Td>
                  <Table.Td><Text size="xs">{c.name}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{c.base_symbol}/{c.quote_symbol}</Text></Table.Td>
                  <Table.Td><Text size="xs" c="dimmed">{c.scenario_count} scenarios</Text></Table.Td>
                  <Table.Td><Text size="xs">{c.winner ? `★ ${c.winner}` : "—"}</Text></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      {selectedCmp != null && <ComparisonDetail id={selectedCmp} />}
    </Stack>
  );
}
