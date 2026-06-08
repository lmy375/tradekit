import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Code, Group, Loader, Select, Stack, Table, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { getTrades, postReconcile, type PageProps, type TradeRow } from "../api";

export function Trades({ status: _status }: PageProps) {
  const [trades, setTrades] = useState<TradeRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  // Filter state — these mirror the CLI/MCP filters (status / token / note). Empty = no filter.
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [tokenFilter, setTokenFilter] = useState("");
  const [noteFilter, setNoteFilter] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getTrades({
        limit: 200,
        status: (statusFilter as "success" | "failed" | "pending" | null) ?? undefined,
        token: tokenFilter.trim() || undefined,
        note: noteFilter.trim() || undefined,
      });
      setTrades(r.trades);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, tokenFilter, noteFilter]);
  useEffect(() => { refresh(); }, [refresh]);

  if (loading && !trades) return <Loader size="sm" />;

  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        <Group gap="sm">
          <Select
            size="xs"
            w={130}
            label="Status"
            placeholder="any"
            value={statusFilter}
            onChange={setStatusFilter}
            data={[
              { value: "success", label: "success" },
              { value: "pending", label: "pending" },
              { value: "failed", label: "failed" },
            ]}
            clearable
          />
          <TextInput
            size="xs"
            w={140}
            label="Token"
            placeholder="symbol or addr"
            value={tokenFilter}
            onChange={(e) => setTokenFilter(e.currentTarget.value)}
          />
          <TextInput
            size="xs"
            w={180}
            label="Note contains"
            placeholder="campaign tag…"
            value={noteFilter}
            onChange={(e) => setNoteFilter(e.currentTarget.value)}
          />
        </Group>
        <Group gap="xs">
          {/* Always visible: pending trades may exist outside the current filter (e.g. user
              looking at status=success). Clicking when there are zero pending is harmless —
              the report says "Scanned 0" and we surface it as a neutral toast. The yellow
              accent draws the eye when there IS a pending row in view. */}
          <Button
            size="xs"
            color={trades?.some((t) => t.status === "pending") ? "yellow" : "gray"}
            variant="light"
            loading={reconciling}
            onClick={async () => {
              setReconciling(true);
              try {
                const r = await postReconcile();
                if (r.report.scanned === 0) {
                  notifications.show({ color: "blue", message: "No pending trades to reconcile." });
                } else {
                  notifications.show({
                    color: r.report.errors.length === 0 ? "green" : "yellow",
                    message:
                      `Reconciled ${r.report.scanned}: ` +
                      `${r.report.resolvedSuccess} success · ${r.report.resolvedFailed} failed · ` +
                      `${r.report.stillPending} still pending`,
                  });
                }
                await refresh();
              } catch (e) {
                notifications.show({ color: "red", message: (e as Error).message });
              } finally {
                setReconciling(false);
              }
            }}
          >
            Reconcile pending
          </Button>
          <Button size="xs" variant="light" onClick={refresh} loading={loading}>Refresh</Button>
        </Group>
      </Group>
      <Card withBorder p={0}>
        {(!trades || trades.length === 0) && <Text c="dimmed" p="md">No trades yet.</Text>}
        {trades && trades.length > 0 && (
          <Table withRowBorders={false} verticalSpacing={6} striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Time</Table.Th>
                <Table.Th>Chain</Table.Th>
                <Table.Th>Dir</Table.Th>
                <Table.Th>Base</Table.Th>
                <Table.Th>Quote</Table.Th>
                <Table.Th>Price</Table.Th>
                <Table.Th>Aggregator</Table.Th>
                <Table.Th>Tx</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Note</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {trades.map((t) => {
                // Transfers are stored as direction="sell" with aggregator="transfer"
                // so dailyUsdVolume picks them up. The UI shows them as "xfer" (blue)
                // so users don't mistake outbound moves for failed sells.
                const isTransfer = t.aggregator === "transfer";
                const dirLabel = isTransfer ? "xfer" : t.direction;
                const dirColor = isTransfer ? "blue" : t.direction === "buy" ? "green" : "red";
                // Pending status (iter31) shouldn't be a scary red — it just means the
                // receipt timed out and the tx may still confirm. Yellow signals "wait".
                const statusColor =
                  t.status === "success" ? "green" : t.status === "pending" ? "yellow" : "red";
                return (
                  <Table.Tr key={t.id}>
                    <Table.Td>{t.timestamp.slice(0, 19).replace("T", " ")}</Table.Td>
                    <Table.Td>{t.chain}</Table.Td>
                    <Table.Td>
                      <Badge size="xs" color={dirColor}>
                        {dirLabel}
                      </Badge>
                    </Table.Td>
                    <Table.Td ff="monospace">{t.base_amount} {t.base_symbol ?? ""}</Table.Td>
                    <Table.Td ff="monospace">{t.quote_amount} {t.quote_symbol ?? ""}</Table.Td>
                    <Table.Td ff="monospace">{t.price}</Table.Td>
                    <Table.Td>{t.aggregator ?? "?"}</Table.Td>
                    <Table.Td ff="monospace"><Code fz="xs">{(t.tx_hash ?? "").slice(0, 14)}…</Code></Table.Td>
                    <Table.Td>
                      <Badge size="xs" color={statusColor}>
                        {t.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      {t.notes && (
                        <Text size="xs" c="dimmed" title={t.notes} lineClamp={1} maw={220}>
                          {t.notes}
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </Card>
    </Stack>
  );
}
