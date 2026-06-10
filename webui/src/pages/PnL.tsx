import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { getPnL, getEquity, type PnLReport, type PageProps, type EquityCurveResp } from "../api";

function EquitySvg({ points }: { points: Array<{ at: string; totalUsd: number }> }) {
  if (points.length < 2) return null;
  const w = 640, h = 120, pad = 4;
  const vals = points.map((p) => p.totalUsd);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const xy = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((p.totalUsd - min) / span) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 120 }} preserveAspectRatio="none">
      <polyline
        points={xy.join(" ")}
        fill="none"
        stroke={up ? "var(--mantine-color-teal-5)" : "var(--mantine-color-red-5)"}
        strokeWidth={1.5}
      />
    </svg>
  );
}

function EquityCard() {
  const [curve, setCurve] = useState<EquityCurveResp | null>(null);
  useEffect(() => {
    getEquity("90d").then(setCurve).catch(() => setCurve(null));
  }, []);
  if (!curve || curve.points.length === 0) return null; // feed not enabled — stay quiet
  const sign = (curve.changeAbs ?? 0) >= 0 ? "+" : "";
  return (
    <Card withBorder padding="sm" mb="md">
      <Group justify="space-between" mb={4}>
        <Title order={6}>Equity (90d) · {curve.accountsKey} × {curve.chainsKey}</Title>
        <Text size="xs" c={(curve.changeAbs ?? 0) >= 0 ? "teal" : "red"} ff="monospace">
          {sign}{curve.changeAbs?.toFixed(2)} ({sign}{curve.changePct?.toFixed(2)}%) · max DD {curve.maxDrawdownPct?.toFixed(1)}%
        </Text>
      </Group>
      <EquitySvg points={curve.points} />
      <Text size="xs" c="dimmed" ff="monospace">
        now ${curve.lastUsd?.toFixed(2)} · peak ${curve.peakUsd?.toFixed(2)} · {curve.points.length} snapshots
      </Text>
    </Card>
  );
}

export function PnL({ status: _status }: PageProps) {
  const [r, setR] = useState<PnLReport | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await getPnL();
      setR(resp.report);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  if (!r) return loading ? <Loader size="sm" /> : null;

  const pl = (n: number) => (
    <Text component="span" c={n >= 0 ? "green.5" : "red.5"} fw={600} ff="monospace">
      ${n.toFixed(2)}
    </Text>
  );

  return (
    <Stack>
      <Group justify="space-between">
        <Text c="dimmed">Account: <b>{r.account}</b></Text>
        <Button size="xs" variant="light" onClick={refresh} loading={loading}>Refresh</Button>
      </Group>

      <EquityCard />

      <SimpleGrid cols={{ base: 1, sm: 4 }}>
        <Card withBorder>
          <Text size="xs" c="dimmed">Realized (gross)</Text>
          <Text size="lg">{pl(r.totalRealizedUsd)}</Text>
        </Card>
        <Card withBorder>
          <Text size="xs" c="dimmed">Gas paid</Text>
          <Text size="lg" ff="monospace">${r.totalGasUsd.toFixed(2)}</Text>
        </Card>
        <Card withBorder>
          <Text size="xs" c="dimmed">Realized after gas</Text>
          <Text size="lg">{pl(r.totalRealizedAfterGasUsd)}</Text>
        </Card>
        <Card withBorder>
          <Text size="xs" c="dimmed">Unrealized (mark)</Text>
          <Text size="lg">{pl(r.totalUnrealizedUsd)}</Text>
        </Card>
      </SimpleGrid>

      {r.positions.length > 0 && (
        <Card withBorder p={0}>
          <Table verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Symbol</Table.Th>
                <Table.Th>Chain</Table.Th>
                <Table.Th>Amount</Table.Th>
                <Table.Th>Avg cost</Table.Th>
                <Table.Th>Mark</Table.Th>
                <Table.Th>Unrealized</Table.Th>
                <Table.Th>Realized</Table.Th>
                <Table.Th>Trades</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {r.positions.map((p) => (
                <Table.Tr key={`${p.chain}-${p.symbol}`}>
                  <Table.Td>{p.symbol}</Table.Td>
                  <Table.Td>{p.chain}</Table.Td>
                  <Table.Td ff="monospace">{p.amount}</Table.Td>
                  <Table.Td ff="monospace">${p.avgCostUsd.toFixed(4)}</Table.Td>
                  <Table.Td ff="monospace">
                    {p.currentPriceUsd != null ? `$${p.currentPriceUsd.toFixed(4)}` : "—"}
                  </Table.Td>
                  <Table.Td>{p.unrealizedUsd != null ? pl(p.unrealizedUsd) : "—"}</Table.Td>
                  <Table.Td>{pl(p.realizedUsd)}</Table.Td>
                  <Table.Td>{p.trades}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      {r.gas.length > 0 && (
        <Card withBorder>
          <Text fw={600} mb="xs" c="dimmed">Gas by chain</Text>
          <Stack gap={4}>
            {r.gas.map((g) => (
              <Group key={g.chain} gap="xs">
                <Badge variant="light">{g.chain}</Badge>
                <Text size="sm" ff="monospace">{g.amount}</Text>
                {g.usd != null && <Text size="sm" c="dimmed">${g.usd.toFixed(4)}</Text>}
              </Group>
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
