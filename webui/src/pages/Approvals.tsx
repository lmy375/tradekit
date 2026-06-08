import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Loader,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { getAllowances, postRevoke, type ApprovalRow, type PageProps } from "../api";

export function Approvals({ status: _status }: PageProps) {
  const [rows, setRows] = useState<ApprovalRow[] | null>(null);
  const [chain, setChain] = useState<string>("");
  const [address, setAddress] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [busyAll, setBusyAll] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getAllowances();
      setRows(r.allowances);
      setChain(r.chain);
      setAddress(r.address);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  async function revokeOne(token: string, spender: string) {
    if (!confirm("Revoke this approval? This sends an on-chain transaction.")) return;
    try {
      await postRevoke(token, spender);
      notifications.show({ color: "green", message: "Revoked" });
      refresh();
    } catch (e) {
      const err = e as Error & { code?: string };
      notifications.show({ color: "red", title: err.code ?? "Error", message: err.message });
    }
  }

  async function revokeAll() {
    if (!rows || rows.length === 0) return;
    if (!confirm(`This will send ${rows.length} on-chain revoke transactions. Continue?`)) return;
    setBusyAll(true);
    let ok = 0, fail = 0;
    for (const a of rows) {
      try {
        await postRevoke(a.token, a.spender);
        ok++;
      } catch {
        fail++;
      }
    }
    setBusyAll(false);
    notifications.show({
      color: fail === 0 ? "green" : "yellow",
      message: `Done: ${ok} revoked, ${fail} failed`,
    });
    refresh();
  }

  if (loading && !rows) return <Loader size="sm" />;

  return (
    <Stack>
      <Alert variant="light" color="blue">
        Probes well-known aggregator routers × the chain profile's token list. Anything non-zero is
        a sitting allowance — review and revoke unused ones.
      </Alert>
      <Group justify="space-between">
        <Text c="dimmed" size="sm">
          Chain: <b>{chain}</b>  ·  Address: <Code>{address}</Code>
        </Text>
        <Group>
          <Button size="xs" variant="light" onClick={refresh} loading={loading}>Refresh</Button>
          <Button size="xs" color="red" variant="filled" onClick={revokeAll} loading={busyAll} disabled={!rows || rows.length === 0}>
            Revoke ALL
          </Button>
        </Group>
      </Group>

      <Card withBorder p={0}>
        {rows && rows.length === 0 && <Text c="dimmed" p="md">No standing approvals.</Text>}
        {rows && rows.length > 0 && (
          <Table verticalSpacing={6} striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Token</Table.Th>
                <Table.Th>Allowance</Table.Th>
                <Table.Th>Spender</Table.Th>
                <Table.Th>Label</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((a, i) => (
                <Table.Tr key={i}>
                  <Table.Td>{a.symbol}</Table.Td>
                  <Table.Td ff="monospace">
                    {a.display}{" "}
                    {a.display === "infinite" && <Badge color="red" size="xs">⚠ INFINITE</Badge>}
                  </Table.Td>
                  <Table.Td ff="monospace"><Code fz="xs">{a.spender}</Code></Table.Td>
                  <Table.Td c="dimmed">{a.spenderLabel ?? ""}</Table.Td>
                  <Table.Td>
                    <Button size="xs" variant="default" onClick={() => revokeOne(a.token, a.spender)}>
                      Revoke
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>
    </Stack>
  );
}
