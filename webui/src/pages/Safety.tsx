import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Card,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import {
  getSafety,
  type GapSeverity,
  type HeadroomStatus,
  type PageProps,
  type SafetyResp,
  type SafetyVerdict,
} from "../api";

const VERDICT_COLOR: Record<SafetyVerdict, string> = {
  hardened: "teal",
  moderate: "yellow",
  exposed: "red",
};
const SEVERITY_COLOR: Record<GapSeverity, string> = {
  critical: "red",
  warn: "yellow",
  info: "blue",
};
const STATUS_COLOR: Record<HeadroomStatus, string> = {
  ok: "teal",
  approaching: "yellow",
  exhausted: "orange",
  tripped: "red",
};
const STATE_COLOR: Record<string, string> = {
  active: "teal",
  partial: "yellow",
  off: "gray",
};

function num(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

export function Safety({ status: _status }: PageProps) {
  const [data, setData] = useState<SafetyResp | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getSafety());
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  if (!data) return loading ? <Loader size="sm" /> : null;
  const { posture, headroom } = data;
  const c = posture.counts;

  return (
    <Stack>
      <Group justify="space-between">
        <Text c="dimmed" size="sm">
          Operator-trust posture — what guardrails are <b>configured</b> (the config audit) and how much
          <b> room is left</b> on the active limits (runtime headroom). Read-only, network-free.
        </Text>
        <Badge color={VERDICT_COLOR[posture.verdict]} size="lg" variant="filled">
          {posture.verdict}
        </Badge>
      </Group>

      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <Card withBorder padding="sm">
          <Text size="xs" c="dimmed">Guardrails active</Text>
          <Text fw={700} ff="monospace">{c.activeGuardrails}/{c.totalGuardrails}</Text>
        </Card>
        <Card withBorder padding="sm">
          <Text size="xs" c="dimmed">Critical gaps</Text>
          <Text fw={700} ff="monospace" c={c.critical > 0 ? "red.4" : undefined}>{c.critical}</Text>
        </Card>
        <Card withBorder padding="sm">
          <Text size="xs" c="dimmed">Warnings</Text>
          <Text fw={700} ff="monospace" c={c.warn > 0 ? "yellow.6" : undefined}>{c.warn}</Text>
        </Card>
        <Card withBorder padding="sm">
          <Text size="xs" c="dimmed">Binding constraint</Text>
          {headroom.binding ? (
            <>
              <Text fw={700} ff="monospace">{num(headroom.binding.utilizationPct, 0)}%</Text>
              <Text size="xs" c="dimmed">{headroom.binding.label}</Text>
            </>
          ) : (
            <Text fw={700} ff="monospace">—</Text>
          )}
        </Card>
      </SimpleGrid>

      {posture.gaps.length > 0 && (
        <Alert
          color={c.critical > 0 ? "red" : c.warn > 0 ? "yellow" : "blue"}
          variant="light"
          title={`${posture.gaps.length} exposure${posture.gaps.length === 1 ? "" : "s"} — close with the listed config`}
        >
          <Table verticalSpacing={2} withRowBorders={false}>
            <Table.Tbody>
              {posture.gaps.map((g) => (
                <Table.Tr key={g.key}>
                  <Table.Td><Badge size="sm" color={SEVERITY_COLOR[g.severity]} variant="light">{g.severity}</Badge></Table.Td>
                  <Table.Td><Text size="sm">{g.finding}</Text></Table.Td>
                  <Table.Td><Text size="xs" c="dimmed" ff="monospace">{g.fix}</Text></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Alert>
      )}

      {headroom.entries.length > 0 && (
        <Card withBorder padding="sm">
          <Title order={6} mb={6}>Runtime headroom</Title>
          <Table verticalSpacing={2} withRowBorders={false}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th><Text size="xs" c="dimmed">limit</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">scope</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">used / cap</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">util</Text></Table.Th>
                <Table.Th><Text size="xs" c="dimmed">status</Text></Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {headroom.entries.map((e) => (
                <Table.Tr key={e.key}>
                  <Table.Td><Text size="xs">{e.label}</Text></Table.Td>
                  <Table.Td><Text size="xs" c="dimmed" ff="monospace">{e.scope}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{e.limit == null ? "—" : `${num(e.used)} / ${num(e.limit)}`}</Text></Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{e.utilizationPct == null ? "—" : `${num(e.utilizationPct, 0)}%`}</Text></Table.Td>
                  <Table.Td><Badge size="sm" color={STATUS_COLOR[e.status]} variant="light">{e.status}</Badge></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      <Card withBorder padding="sm">
        <Title order={6} mb={6}>Guardrails</Title>
        <Table verticalSpacing={2} withRowBorders={false}>
          <Table.Tbody>
            {posture.guardrails.map((g) => (
              <Table.Tr key={g.key}>
                <Table.Td><Badge size="sm" color={STATE_COLOR[g.state] ?? "gray"} variant="light">{g.state}</Badge></Table.Td>
                <Table.Td><Text size="xs">{g.label}</Text></Table.Td>
                <Table.Td><Text size="xs" c="dimmed" ff="monospace">{g.detail}</Text></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
    </Stack>
  );
}
