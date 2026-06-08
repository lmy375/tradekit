import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Code, Group, Loader, Stack, Table, TextInput } from "@mantine/core";
import { getAudit, type AuditRow, type PageProps } from "../api";

export function Audit({ status: _status }: PageProps) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Filter state mirrors CLI/MCP: tool, account, chain, since.
  const [toolFilter, setToolFilter] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [chainFilter, setChainFilter] = useState("");
  const [sinceFilter, setSinceFilter] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getAudit({
        limit: 100,
        tool: toolFilter.trim() || undefined,
        account: accountFilter.trim() || undefined,
        chain: chainFilter.trim() || undefined,
        since: sinceFilter.trim() || undefined,
      });
      setRows(r.entries);
    } finally {
      setLoading(false);
    }
  }, [toolFilter, accountFilter, chainFilter, sinceFilter]);
  useEffect(() => { refresh(); }, [refresh]);

  if (loading && !rows) return <Loader size="sm" />;

  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        <Group gap="sm">
          <TextInput
            size="xs"
            w={130}
            label="Tool"
            placeholder="quote, buy…"
            value={toolFilter}
            onChange={(e) => setToolFilter(e.currentTarget.value)}
          />
          <TextInput
            size="xs"
            w={130}
            label="Account"
            placeholder="label"
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.currentTarget.value)}
          />
          <TextInput
            size="xs"
            w={120}
            label="Chain"
            placeholder="base"
            value={chainFilter}
            onChange={(e) => setChainFilter(e.currentTarget.value)}
          />
          <TextInput
            size="xs"
            w={150}
            label="Since"
            placeholder="YYYY-MM-DD"
            value={sinceFilter}
            onChange={(e) => setSinceFilter(e.currentTarget.value)}
          />
        </Group>
        <Button size="xs" variant="light" onClick={refresh} loading={loading}>Refresh</Button>
      </Group>
      <Card withBorder p={0}>
        <Table verticalSpacing={6} striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Time</Table.Th>
              <Table.Th>Caller</Table.Th>
              <Table.Th>Tool</Table.Th>
              <Table.Th>Chain</Table.Th>
              <Table.Th>Account</Table.Th>
              <Table.Th>Result</Table.Th>
              <Table.Th>Tx</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(rows ?? []).map((e) => (
              <Table.Tr key={e.id}>
                <Table.Td>{e.timestamp.slice(0, 19).replace("T", " ")}</Table.Td>
                <Table.Td>{e.caller ?? "-"}</Table.Td>
                <Table.Td>{e.tool}</Table.Td>
                <Table.Td>{e.chain ?? "-"}</Table.Td>
                <Table.Td>{e.account ?? "-"}</Table.Td>
                <Table.Td>
                  <Badge size="xs" color={e.result === "ok" ? "green" : "red"}>
                    {e.result === "ok" ? "ok" : (e.error_code ?? "err")}
                  </Badge>
                </Table.Td>
                <Table.Td ff="monospace">
                  {e.tx_hash ? <Code fz="xs">{e.tx_hash.slice(0, 14)}…</Code> : ""}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
    </Stack>
  );
}
