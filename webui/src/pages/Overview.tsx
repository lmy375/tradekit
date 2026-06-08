import { useEffect, useState } from "react";
import { Card, Code, Stack, Text } from "@mantine/core";
import type { PageProps } from "../api";
import { getStatus } from "../api";

export function Overview({ status: initial }: PageProps) {
  const [status, setStatus] = useState(initial);

  useEffect(() => {
    const t = setInterval(() => {
      getStatus().then(setStatus).catch(() => {});
    }, 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <Stack>
      <Card withBorder>
        <Text fw={600} c="blue.4" mb="xs">Active session</Text>
        <Stack gap={4}>
          <Text size="sm">
            Account: <Code>{status.activeAccount}</Code>
          </Text>
          <Text size="sm">
            Chain: <Code>{status.activeChain}</Code>
          </Text>
          <Text size="sm">
            Address: <Code>{status.address ?? "(none)"}</Code>
          </Text>
          <Text size="sm" c="dimmed" mt="xs">
            Chains available: {status.chains.join(", ")}
          </Text>
        </Stack>
      </Card>
      <Card withBorder>
        <Text fw={600} c="blue.4" mb="xs">Quick tips</Text>
        <Stack gap={4}>
          <Text size="sm">• Holdings tab: see balances across all chains.</Text>
          <Text size="sm">• Trade tab: simulate before sending; size context shown on the result.</Text>
          <Text size="sm">• Approvals tab: review and revoke standing token approvals — security hygiene.</Text>
          <Text size="sm">• Chart tab: K-line via OKX public candle data.</Text>
        </Stack>
      </Card>
    </Stack>
  );
}
