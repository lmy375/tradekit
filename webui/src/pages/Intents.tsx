import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Loader,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import type { PageProps } from "../api";
import { api } from "../api";

// v102: the trade-approval intent queue (v47 — agent proposes, human decides).
// READ-ONLY by design: approve/reject is CLI-only (a prompt-injected agent — or
// a less-authenticated web session — must never approve the agent's own
// spending). This page lets the operator REVIEW the proposed trade + WHY it was
// gated on the dashboard, then run the shown CLI command to decide.
interface IntentRow {
  id: number;
  status: "pending" | "executed" | "failed" | "rejected" | "expired";
  tool: "buy" | "sell";
  chain: string;
  account: string | null;
  est_usd: number | null;
  reason: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_note: string | null;
  approvalReasons: string[];
  base: string | null;
  quote: string | null;
  preview: {
    price: string | null;
    baseAmount: string | null;
    quoteAmount: string | null;
    baseSymbol: string | null;
    quoteSymbol: string | null;
    aggregator: string | null;
  } | null;
  approveCmd: string;
  rejectCmd: string;
}

const STATUS_COLOR: Record<IntentRow["status"], string> = {
  pending: "yellow",
  executed: "green",
  failed: "red",
  rejected: "gray",
  expired: "gray",
};

function minutesLeft(expiresAt: string): number {
  return Math.round((Date.parse(expiresAt) - Date.now()) / 60_000);
}

export function Intents({ status: _status }: PageProps) {
  const [rows, setRows] = useState<IntentRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ ok: true; intents: IntentRow[] }>("/api/intents?limit=100");
      setRows(r.intents);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (loading && !rows) return <Loader size="sm" />;

  const pending = (rows ?? []).filter((r) => r.status === "pending");
  const past = (rows ?? []).filter((r) => r.status !== "pending");

  return (
    <Stack>
      <Alert variant="light" color={pending.length > 0 ? "yellow" : "blue"}>
        Agent-proposed trades gated by <Code>safety.tradeApproval</Code>. Review the proposed trade and
        why it was gated here, then <b>decide on the CLI</b> — approval is CLI-only by design (a
        prompt-injected agent must never approve its own spending).
      </Alert>

      <Group justify="space-between">
        <Text c="dimmed" size="sm">
          {pending.length} pending · {past.length} past (last 100)
        </Text>
        <Button size="xs" variant="light" onClick={refresh} loading={loading}>Refresh</Button>
      </Group>

      {pending.length === 0 && <Text c="dimmed">No trades awaiting approval.</Text>}

      {pending.map((r) => {
        const mins = minutesLeft(r.expires_at);
        const pair = r.preview?.baseSymbol && r.preview?.quoteSymbol
          ? `${r.preview.baseSymbol}/${r.preview.quoteSymbol}`
          : `${r.base ?? "?"}/${r.quote ?? "?"}`;
        return (
          <Card withBorder key={r.id}>
            <Group justify="space-between" mb="xs">
              <Group gap="xs">
                <Badge color={r.tool === "buy" ? "teal" : "orange"} variant="filled">{r.tool.toUpperCase()}</Badge>
                <Text fw={700}>{pair}</Text>
                {r.est_usd != null && <Text ff="monospace">~${r.est_usd.toFixed(2)}</Text>}
                <Text size="xs" c="dimmed">#{r.id} · {r.chain}{r.account ? ` · ${r.account}` : ""}</Text>
              </Group>
              <Badge color={mins <= 5 ? "red" : "yellow"} variant="light">
                {mins > 0 ? `expires in ${mins}m` : "expiring"}
              </Badge>
            </Group>

            {/* v101: WHY the gate routed this to a human. */}
            {r.approvalReasons.length > 0 && (
              <Stack gap={2} mb="xs">
                {r.approvalReasons.map((reason, i) => (
                  <Text key={i} size="sm" c="yellow.7">⚠ {reason}</Text>
                ))}
              </Stack>
            )}

            {r.preview && (
              <Text size="sm" ff="monospace" c="dimmed">
                {r.preview.baseAmount} base ⇄ {r.preview.quoteAmount} quote @ {r.preview.price}
                {r.preview.aggregator ? ` via ${r.preview.aggregator}` : ""}
              </Text>
            )}
            {r.reason && <Text size="sm" mt={4}>Agent reason: {r.reason}</Text>}

            <Group mt="sm" gap="xs">
              <CopyButton value={r.approveCmd}>
                {({ copied, copy }) => (
                  <Button size="xs" color="green" variant={copied ? "filled" : "light"} onClick={copy}>
                    {copied ? "Copied!" : "Copy approve cmd"}
                  </Button>
                )}
              </CopyButton>
              <CopyButton value={r.rejectCmd}>
                {({ copied, copy }) => (
                  <Button size="xs" color="red" variant={copied ? "filled" : "light"} onClick={copy}>
                    {copied ? "Copied!" : "Copy reject cmd"}
                  </Button>
                )}
              </CopyButton>
              <Code fz="xs">{r.approveCmd}</Code>
            </Group>
          </Card>
        );
      })}

      {past.length > 0 && (
        <Card withBorder p={0} mt="md">
          <Text fw={600} p="sm" pb={4}>Recent decisions</Text>
          <Table verticalSpacing={6} striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>#</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Trade</Table.Th>
                <Table.Th>~USD</Table.Th>
                <Table.Th>Decided</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {past.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td>{r.id}</Table.Td>
                  <Table.Td><Badge color={STATUS_COLOR[r.status]} size="sm" variant="light">{r.status}</Badge></Table.Td>
                  <Table.Td>{r.tool} {r.preview?.baseSymbol ?? r.base ?? "?"}</Table.Td>
                  <Table.Td ff="monospace">{r.est_usd != null ? `$${r.est_usd.toFixed(2)}` : "—"}</Table.Td>
                  <Table.Td c="dimmed" fz="xs">{r.decided_note ?? (r.decided_at ? r.decided_at.slice(0, 16) : "—")}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}
    </Stack>
  );
}
