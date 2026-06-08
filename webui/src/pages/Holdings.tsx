import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { getHoldings, type HoldingsReport, type PageProps } from "../api";

export function Holdings({ status: _status }: PageProps) {
  const [reports, setReports] = useState<HoldingsReport[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await getHoldings();
      setReports(r.reports);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading && !reports) return <Loader size="sm" />;
  if (err) return <Text c="red">{err}</Text>;
  if (!reports) return null;

  const grand = reports.reduce((sum, r) => sum + (r.totalUsd ?? 0), 0);
  const nonEmpty = reports.filter((r) => r.balances.some((b) => parseFloat(b.amount) > 0));

  return (
    <Stack>
      <Group justify="space-between">
        <Text size="lg">
          Grand total: <b>${grand.toFixed(2)}</b>
        </Text>
        <Button size="xs" variant="light" onClick={refresh} loading={loading}>
          Refresh
        </Button>
      </Group>
      {nonEmpty.length === 0 && <Text c="dimmed">No balances on any chain.</Text>}
      {nonEmpty.map((r) => (
        <Card key={r.chain} withBorder>
          <Group justify="space-between" mb="xs">
            <Group gap="xs">
              <Text fw={600} c="blue.4">{r.chain}</Text>
              <Badge variant="light" color="gray">id {r.chainId}</Badge>
            </Group>
            {r.totalUsd != null && (
              <Badge variant="light" color="green">
                ${r.totalUsd.toFixed(2)}
              </Badge>
            )}
          </Group>
          <Table withRowBorders={false} verticalSpacing={4}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Symbol</Table.Th>
                <Table.Th>Amount</Table.Th>
                <Table.Th ta="right">USD</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {r.balances
                .filter((b) => parseFloat(b.amount) > 0)
                .map((b) => (
                  <Table.Tr key={b.symbol}>
                    <Table.Td>{b.symbol}</Table.Td>
                    <Table.Td ff="monospace">{b.amount}</Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {b.usd != null ? `$${b.usd.toFixed(2)}` : "—"}
                    </Table.Td>
                  </Table.Tr>
                ))}
            </Table.Tbody>
          </Table>
        </Card>
      ))}
    </Stack>
  );
}
