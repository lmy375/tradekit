import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Card,
  Group,
  Loader,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { getExecutionReport, type ExecutionReportResp, type PageProps, type SlippageStatsResp } from "../api";

function bps(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;
}

function slipText(s: SlippageStatsResp): string {
  if (s.samples === 0) return "no samples";
  return `med ${bps(s.medianBps)} · p90 ${bps(s.p90Bps)} (${s.samples})`;
}

export function Execution({ status: _status }: PageProps) {
  const [report, setReport] = useState<ExecutionReportResp | null>(null);
  const [window_, setWindow] = useState("30d");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await getExecutionReport({ since: window_ }));
    } catch {
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [window_]);
  useEffect(() => { refresh(); }, [refresh]);

  if (!report) return loading ? <Loader size="sm" /> : null;
  const t = report.totals;

  return (
    <Stack>
      <Group justify="space-between">
        <Text c="dimmed" size="sm">
          Execution quality over <b>real</b> fills — signed slippage, <b>positive = worse than quoted</b>.
          Paper fills excluded (simulated slippage isn't execution quality).
        </Text>
        <SegmentedControl
          size="xs"
          data={["7d", "30d", "90d"]}
          value={window_}
          onChange={setWindow}
        />
      </Group>

      {t.attempts === 0 ? (
        <Text c="dimmed">No real swaps in window.</Text>
      ) : (
        <>
          <SimpleGrid cols={{ base: 2, sm: 4 }}>
            <Card withBorder padding="sm">
              <Text size="xs" c="dimmed">Attempts</Text>
              <Text fw={700} ff="monospace">{t.attempts}</Text>
              <Text size="xs" c="dimmed">{t.fills} filled · {t.failed} failed{t.successRatePct != null ? ` · ${t.successRatePct.toFixed(0)}% ok` : ""}</Text>
            </Card>
            <Card withBorder padding="sm">
              <Text size="xs" c="dimmed">Volume</Text>
              <Text fw={700} ff="monospace">${t.usdVolume.toFixed(0)}</Text>
            </Card>
            <Card withBorder padding="sm">
              <Text size="xs" c="dimmed">Slippage (median)</Text>
              <Text fw={700} ff="monospace">{bps(t.slippage.medianBps)}bps</Text>
              <Text size="xs" c="dimmed">p90 {bps(t.slippage.p90Bps)} · coverage {t.slippageCoveragePct != null ? `${t.slippageCoveragePct.toFixed(0)}%` : "—"}</Text>
            </Card>
            <Card withBorder padding="sm">
              <Text size="xs" c="dimmed">Gas (native)</Text>
              {t.gasByChain.length === 0 ? <Text fw={700} ff="monospace">—</Text> :
                t.gasByChain.map((g) => (
                  <Text key={g.chain} size="xs" ff="monospace">{g.chain}: {g.totalNative.toPrecision(3)} (avg {g.avgNative.toPrecision(2)})</Text>
                ))}
            </Card>
          </SimpleGrid>

          {report.recommendations.length > 0 && (
            <Alert color="yellow" variant="light" title="Recommendations">
              <Stack gap={4}>
                {report.recommendations.map((r, i) => <Text key={i} size="sm">{r}</Text>)}
              </Stack>
            </Alert>
          )}

          {report.byAggregator.length > 0 && (
            <Card withBorder padding="sm">
              <Title order={6} mb={6}>By aggregator</Title>
              <Table verticalSpacing={2} withRowBorders={false}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th><Text size="xs" c="dimmed">name</Text></Table.Th>
                    <Table.Th><Text size="xs" c="dimmed">fills</Text></Table.Th>
                    <Table.Th><Text size="xs" c="dimmed">share</Text></Table.Th>
                    <Table.Th><Text size="xs" c="dimmed">median bps</Text></Table.Th>
                    <Table.Th><Text size="xs" c="dimmed">p90</Text></Table.Th>
                    <Table.Th><Text size="xs" c="dimmed">success</Text></Table.Th>
                    <Table.Th><Text size="xs" c="dimmed">volume</Text></Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {report.byAggregator.map((a) => (
                    <Table.Tr key={a.aggregator}>
                      <Table.Td><Badge size="sm" variant="light">{a.aggregator}</Badge></Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">{a.fills}</Text></Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">{a.sharePct.toFixed(0)}%</Text></Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">{bps(a.slippage.medianBps)}</Text></Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">{bps(a.slippage.p90Bps)}</Text></Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">{a.successRatePct != null ? `${a.successRatePct.toFixed(0)}%` : "—"}</Text></Table.Td>
                      <Table.Td><Text size="xs" ff="monospace">${a.usdVolume.toFixed(0)}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Card>
          )}

          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {report.bySize.length > 0 && (
              <Card withBorder padding="sm">
                <Title order={6} mb={6}>By order size</Title>
                {report.bySize.map((b) => (
                  <Group key={b.label} justify="space-between">
                    <Text size="xs" ff="monospace">{b.label}</Text>
                    <Text size="xs" c="dimmed" ff="monospace">{b.fills} fills · {slipText(b.slippage)}</Text>
                  </Group>
                ))}
              </Card>
            )}
            {report.byPair.length > 0 && (
              <Card withBorder padding="sm">
                <Title order={6} mb={6}>By pair (top by volume)</Title>
                {report.byPair.map((p) => (
                  <Group key={p.baseSymbol} justify="space-between">
                    <Text size="xs" ff="monospace">{p.baseSymbol}</Text>
                    <Text size="xs" c="dimmed" ff="monospace">${p.usdVolume.toFixed(0)} · {slipText(p.slippage)}</Text>
                  </Group>
                ))}
              </Card>
            )}
          </SimpleGrid>

          {report.trend && (
            <Card withBorder padding="sm">
              <Title order={6} mb={4}>Trend</Title>
              <Text size="sm">
                last {report.trend.recentDays}d: <Text component="span" ff="monospace">{slipText(report.trend.recent)}</Text>
                {"  vs prior: "}<Text component="span" ff="monospace">{slipText(report.trend.prior)}</Text>
                {report.trend.deltaMedianBps != null && (
                  <Text component="span" c={report.trend.deltaMedianBps >= 0 ? "red.4" : "teal"} fw={600}>
                    {"  → "}{report.trend.deltaMedianBps >= 0 ? "worse" : "better"} by {Math.abs(report.trend.deltaMedianBps).toFixed(1)}bps
                  </Text>
                )}
              </Text>
            </Card>
          )}
        </>
      )}
    </Stack>
  );
}
