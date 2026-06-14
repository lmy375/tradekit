// Strategy page — the per-tag deep dive in the browser.
//
// Renders the same buildStrategyReport core the CLI/MCP use (numbers
// match by construction): identity, composition lifecycle, window
// performance, net positions, risk (budgets + drawdown), recent
// activity, and forward signals (next fire, pending triggers,
// rebalance drift). Deterministic + network-free by route design —
// live-priced views (valuation marks, trigger distances) stay on the
// CLI where the oracle cost is opted into.

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Card,
  Code,
  Group,
  Loader,
  Progress,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  getGains,
  getStrategies,
  getStrategyReport,
  getStrategyCompare,
  type GainsResp,
  type PageProps,
  type StrategyReportResp,
  type StrategyCompareResp,
  type StrategyTag,
} from "../api";

function ago(iso: string | null): string {
  if (!iso) return "—";
  const secs = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(secs)) return iso;
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function ageLabel(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function num(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits).replace(/\.?0+$/, "") || "0";
}

const STATUS_COLORS: Record<string, string> = {
  active: "teal", paused: "yellow", filled: "blue", completed: "blue",
  failed: "red", expired: "gray", cancelled: "gray",
};

function RealizedSvg({ records }: { records: GainsResp["records"] }) {
  if (records.length < 2) return null;
  const w = 640, h = 80, pad = 4;
  let cum = 0;
  const points = records.map((r) => (cum += r.gainQuote));
  const min = Math.min(0, ...points), max = Math.max(0, ...points);
  const span = max - min || 1;
  const xy = points.map((v, i) => {
    const x = pad + (i / (points.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - min) / span) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const up = points[points.length - 1] >= 0;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 80 }} preserveAspectRatio="none">
      <polyline points={xy.join(" ")} fill="none"
        stroke={up ? "var(--mantine-color-teal-5)" : "var(--mantine-color-red-5)"} strokeWidth={1.5} />
    </svg>
  );
}

export function Strategy(_props: PageProps) {
  const [tags, setTags] = useState<StrategyTag[] | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [windowSel, setWindowSel] = useState("30d");
  const [mode, setMode] = useState("auto");
  const [report, setReport] = useState<StrategyReportResp["report"] | null>(null);
  const [compare, setCompare] = useState<StrategyCompareResp | null>(null);
  const [gains, setGains] = useState<GainsResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getStrategies()
      .then((r) => {
        setTags(r.strategies);
        if (r.strategies.length > 0) setTag((cur) => cur ?? r.strategies[0].tag);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const load = useCallback(async () => {
    if (!tag) return;
    setLoading(true);
    try {
      const r = await getStrategyReport(tag, windowSel, mode);
      setReport(r.report);
      // Realized gains ride along — deterministic (pure fill walk), so
      // a failure here never blocks the report.
      getGains({ strategy: tag, mode: r.report.mode })
        .then(setGains)
        .catch(() => setGains(null));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [tag, windowSel, mode]);

  useEffect(() => {
    load();
  }, [load]);

  // v87: ranked cross-strategy comparison (capital allocation). Deterministic,
  // best-effort — a failure leaves the per-tag detail untouched.
  useEffect(() => {
    getStrategyCompare(mode === "paper" ? "paper" : "real")
      .then(setCompare)
      .catch(() => setCompare(null));
  }, [mode]);

  if (error && !report) return <Text c="red">Failed to load: {error}</Text>;
  if (tags == null) return <Group justify="center" p="xl"><Loader size="sm" /></Group>;
  if (tags.length === 0) {
    return (
      <Text c="dimmed" p="xl" ta="center">
        No strategies yet — deploy a playbook or tag trades with --strategy.
      </Text>
    );
  }

  const id = report?.identity;
  const comp = report?.composition;
  const perf = report?.performance;
  const pos = report?.position;
  const risk = report?.risk;
  const act = report?.activity;
  const fwd = report?.forward;

  return (
    <Stack gap="md">
      <Group gap="md" align="flex-end" wrap="wrap">
        <Select
          size="xs"
          w={260}
          label={<Text size="xs" c="dimmed">Strategy</Text>}
          data={tags.map((t) => ({
            value: t.tag,
            label: `${t.tag}${t.live ? " ●" : ""}  (${t.tradeCount} fills)`,
          }))}
          value={tag}
          onChange={(v) => v && setTag(v)}
          searchable
          comboboxProps={{ withinPortal: true }}
        />
        <div>
          <Text size="xs" c="dimmed" mb={4}>Window</Text>
          <SegmentedControl
            size="xs"
            data={["1d", "7d", "30d", "90d", "all"]}
            value={windowSel}
            onChange={setWindowSel}
          />
        </div>
        <div>
          <Text size="xs" c="dimmed" mb={4}>Mode</Text>
          <SegmentedControl size="xs" data={["auto", "real", "paper"]} value={mode} onChange={setMode} />
        </div>
        {loading && <Loader size="xs" mb={6} />}
      </Group>

      {/* v87: ranked cross-strategy comparison — which strategies win/lose, for
          capital allocation. Click a row to drill into its detail below. */}
      {compare && compare.strategies.length > 0 && (
        <Card withBorder padding="sm">
          <Group justify="space-between" mb={6}>
            <Title order={6}>Performance comparison</Title>
            <Text size="xs" c="dimmed">{compare.summary}</Text>
          </Group>
          <Table verticalSpacing={2} highlightOnHover withRowBorders={false}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th><Text size="xs" c="dimmed">#</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">strategy</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">realized $</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">win rate</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">closes</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">trades</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">volume $</Text></Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {compare.strategies.map((s, i) => {
                const bleeding = compare.bleeding.includes(s.strategy);
                return (
                  <Table.Tr
                    key={s.strategy}
                    onClick={() => setTag(s.strategy)}
                    style={{ cursor: "pointer", background: s.strategy === tag ? "var(--mantine-color-dark-6)" : undefined }}
                  >
                    <Table.Td><Text size="xs" c="dimmed">{i + 1}</Text></Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        <Text size="xs" ff="monospace">{s.strategy}</Text>
                        {bleeding && <Badge size="xs" color="red" variant="light">bleeding</Badge>}
                      </Group>
                    </Table.Td>
                    <Table.Td><Text size="xs" ff="monospace" c={s.realizedUsd >= 0 ? "teal" : "red.4"}>{s.realizedUsd >= 0 ? "+" : "−"}${Math.abs(s.realizedUsd).toFixed(2)}</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">{s.winRatePct != null ? `${s.winRatePct.toFixed(0)}% (${s.wins}/${s.wins + s.losses})` : "—"}</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">{s.closes}</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">{s.tradeCount}</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace">${s.volumeUsd.toFixed(0)}</Text></Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
          {compare.unpricedTrades > 0 && (
            <Text size="xs" c="dimmed" mt={4}>
              {compare.unpricedTrades} non-stablecoin-quoted trade(s) excluded from P&L.
            </Text>
          )}
        </Card>
      )}

      {report && id && (
        <Card withBorder padding="sm">
          <Group justify="space-between" wrap="wrap">
            <Group gap="xs">
              <Title order={5}>{id.displayName}</Title>
              <Badge size="sm" color={report.mode === "paper" ? "grape" : "teal"} variant="light">
                {report.mode}
              </Badge>
              {id.playbookId != null && (
                <Badge size="sm" variant="outline" color="gray">playbook #{id.playbookId} · {id.playbookStatus}</Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              age {ageLabel(id.ageSeconds)} · window {report.window} · generated {ago(report.generatedAt)}
            </Text>
          </Group>
        </Card>
      )}

      <Group align="flex-start" grow wrap="wrap">
        {perf && (
          <Card withBorder padding="sm" miw={300}>
            <Title order={6} mb="xs">Performance ({report?.window})</Title>
            <Stack gap={4}>
              <Text size="xs" ff="monospace">
                fills {perf.fills} · failures {perf.failures} · success{" "}
                {perf.successRate == null ? "—" : `${(perf.successRate * 100).toFixed(0)}%`}
              </Text>
              <Text size="xs" ff="monospace">
                buys {perf.buyCount} · sells {perf.sellCount}
              </Text>
              <Text size="xs" ff="monospace">
                net quote {perf.realizedNetQuote >= 0 ? "+" : ""}{num(perf.realizedNetQuote)}{" "}
                (in {num(perf.realizedQuoteReceived)} / out {num(perf.realizedQuoteSpent)})
              </Text>
              <Text size="xs" ff="monospace" c="dimmed">
                slippage avg {num(perf.avgSlippageBps, 1)} · p50 {num(perf.p50SlippageBps, 1)} · p95 {num(perf.p95SlippageBps, 1)} bps
              </Text>
            </Stack>
          </Card>
        )}

        {comp && (
          <Card withBorder padding="sm" miw={300}>
            <Title order={6} mb="xs">
              Composition · {comp.totals.orders} orders / {comp.totals.schedules} schedules / {comp.totals.rebalances} rebalance
            </Title>
            <Group gap={6} mb="xs" wrap="wrap">
              {Object.entries(comp.lifecycle)
                .filter(([, n]) => n > 0)
                .map(([status, n]) => (
                  <Badge key={status} size="xs" color={STATUS_COLORS[status] ?? "gray"} variant="light">
                    {status} {n}
                  </Badge>
                ))}
            </Group>
            <Stack gap={2}>
              {comp.primitives.slice(0, 8).map((p) => (
                <Text key={`${p.kind}-${p.id}`} size="xs" ff="monospace" lineClamp={1}>
                  <Badge size="xs" variant="outline" color={STATUS_COLORS[p.status] ?? "gray"} mr={4}>
                    {p.kind} #{p.id}
                  </Badge>
                  {p.summary}{p.paper ? "  [paper]" : ""}
                </Text>
              ))}
              {comp.primitives.length > 8 && (
                <Text size="xs" c="dimmed">… {comp.primitives.length - 8} more</Text>
              )}
            </Stack>
          </Card>
        )}
      </Group>

      <Group align="flex-start" grow wrap="wrap">
        {pos && pos.positions.length > 0 && (
          <Card withBorder padding="sm" miw={280}>
            <Title order={6} mb="xs">Net positions</Title>
            <Table withTableBorder={false} verticalSpacing={2}>
              <Table.Tbody>
                {pos.positions.map((p, i) => (
                  <Table.Tr key={i}>
                    <Table.Td><Text size="xs" ff="monospace">{p.symbol ?? p.token.slice(0, 10)}</Text></Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace" c={parseFloat(p.netAmount) >= 0 ? "teal" : "red"}>
                        {parseFloat(p.netAmount) >= 0 ? "+" : ""}{num(parseFloat(p.netAmount), 6)}
                      </Text>
                    </Table.Td>
                    <Table.Td><Text size="xs" c="dimmed">{p.chain} · {p.role}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Card>
        )}

        {risk && (risk.budgets.length > 0 || risk.drawdown) && (
          <Card withBorder padding="sm" miw={280}>
            <Title order={6} mb="xs">Risk</Title>
            <Stack gap={6}>
              {risk.budgets.map((b, i) => (
                <div key={i}>
                  <Text size="xs" ff="monospace" mb={2}>budget {b.pattern}</Text>
                  {b.lifetimePctUsed != null && (
                    <Tooltip label={`lifetime: $${num(b.lifetimeSpentUsd)} / $${num(b.lifetimeUsd)}`} withArrow>
                      <Progress size="sm" value={Math.min(100, b.lifetimePctUsed)} color={b.lifetimePctUsed >= 80 ? "red" : "teal"} />
                    </Tooltip>
                  )}
                  {b.dailyPctUsed != null && (
                    <Tooltip label={`daily: $${num(b.dailySpentUsd)} / $${num(b.dailyUsd)}`} withArrow>
                      <Progress size="sm" mt={2} value={Math.min(100, b.dailyPctUsed)} color={b.dailyPctUsed >= 80 ? "red" : "blue"} />
                    </Tooltip>
                  )}
                </div>
              ))}
              {risk.drawdown && (
                <Text size="xs" ff="monospace" c={risk.drawdown.tripped ? "red" : undefined}>
                  drawdown {num(risk.drawdown.drawdownPct, 2)}% from peak ${num(risk.drawdown.peakUsd)}
                  {risk.drawdown.tripped ? "  · TRIPPED" : ""}
                </Text>
              )}
            </Stack>
          </Card>
        )}
      </Group>

      {fwd && (fwd.nextScheduleAt || fwd.pendingTriggers.length > 0 || fwd.rebalanceDrift.length > 0) && (
        <Card withBorder padding="sm">
          <Title order={6} mb="xs">Forward</Title>
          <Stack gap={4}>
            {fwd.nextScheduleAt && (
              <Text size="xs" ff="monospace">
                next schedule fire: {fwd.nextScheduleAt}{fwd.nextScheduleId != null ? ` (schedule #${fwd.nextScheduleId})` : ""}
              </Text>
            )}
            {fwd.pendingTriggers.map((t) => (
              <Text key={t.orderId} size="xs" ff="monospace">
                order #{t.orderId}: {String(t.side ?? "")} {String(t.trigger ?? "")}
                {t.fireThresholdUsd != null ? ` @ $${num(t.fireThresholdUsd as number)}` : ""}
                {t.distancePct != null ? ` · ${num(t.distancePct as number, 2)}% away` : " · distance n/a (no live price on web)"}
              </Text>
            ))}
            {fwd.rebalanceDrift.map((d) => (
              <Group key={d.planId} gap={8} wrap="nowrap">
                <Text size="xs" ff="monospace" w={210} lineClamp={1}>
                  rebalance #{d.planId}{d.name ? ` (${d.name})` : ""}
                </Text>
                <Progress
                  size="sm"
                  style={{ flex: 1 }}
                  value={Math.min(100, d.pctOfThreshold ?? 0)}
                  color={(d.pctOfThreshold ?? 0) >= 80 ? "red" : (d.pctOfThreshold ?? 0) >= 50 ? "yellow" : "teal"}
                />
                <Text size="xs" c="dimmed" w={150}>
                  drift {num(d.lastDriftPct, 2)}% / {d.thresholdPct}%
                </Text>
              </Group>
            ))}
          </Stack>
        </Card>
      )}

      {gains && gains.records.length > 0 && (
        <Card withBorder padding="sm">
          <Group justify="space-between" mb={4}>
            <Title order={6}>Realized P&L (cost-basis, {gains.mode})</Title>
            <Text size="xs" ff="monospace" c={gains.totalGainQuote >= 0 ? "teal" : "red"}>
              {gains.totalGainQuote >= 0 ? "+" : ""}{gains.totalGainQuote.toFixed(2)} · {gains.records.length} realizations
            </Text>
          </Group>
          <RealizedSvg records={gains.records} />
          <Stack gap={2} mt={4}>
            {gains.records.slice(-5).reverse().map((r, i) => (
              <Text key={i} size="xs" ff="monospace" lineClamp={1}>
                {r.at.slice(0, 10)}  {r.symbol ?? "?"}  sold {r.soldAmount.toFixed(6)}  →{" "}
                <Text span c={r.gainQuote >= 0 ? "teal" : "red"} inherit>
                  {r.gainQuote >= 0 ? "+" : ""}{r.gainQuote.toFixed(2)}
                </Text>
              </Text>
            ))}
            {gains.totalUntrackedProceedsQuote > 0 && (
              <Text size="xs" c="dimmed">
                ⚠ {gains.totalUntrackedProceedsQuote.toFixed(2)} untracked-sell proceeds (no basis — excluded from the total)
              </Text>
            )}
          </Stack>
        </Card>
      )}

      {act && (act.recentFills.length > 0 || act.recentFailures.length > 0) && (
        <Card withBorder padding="sm">
          <Title order={6} mb="xs">Recent activity</Title>
          <Stack gap={2}>
            {act.recentFailures.slice(0, 5).map((a, i) => (
              <Text key={`f${i}`} size="xs" ff="monospace" c="red" lineClamp={1}>
                {a.at.slice(0, 16)}Z ✗ {a.summary}
              </Text>
            ))}
            {act.recentFills.slice(0, 10).map((a, i) => (
              <Text key={`s${i}`} size="xs" ff="monospace" lineClamp={1}>
                {a.at.slice(0, 16)}Z ● {a.summary}{a.txHash ? <Code fz={10} ml={4}>{a.txHash.slice(0, 12)}…</Code> : null}
              </Text>
            ))}
          </Stack>
        </Card>
      )}

      {report && !comp && !perf && (
        <Text c="dimmed" size="sm">Report loaded but empty — the tag may have no primitives or trades in this window.</Text>
      )}
    </Stack>
  );
}
