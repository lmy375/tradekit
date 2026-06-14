import { useEffect, useState } from "react";
import {
  Alert, Card, Code, Stack, Text } from "@mantine/core";
import type { PageProps } from "../api";
import { api, getStatus } from "../api";

export function Overview({ status: initial }: PageProps) {
  const [status, setStatus] = useState(initial);
  const [pendingIntents, setPendingIntents] = useState(0);

  useEffect(() => {
    const t = setInterval(() => {
      getStatus().then(setStatus).catch(() => {});
    }, 15_000);
    return () => clearInterval(t);
  }, []);

  // v47.5: surface the approval queue where the operator lands first
  // — an open intent means an agent is blocked waiting on a human.
  useEffect(() => {
    const poll = () =>
      api.get<{ pending: number }>("/api/intents?status=pending&limit=1")
        .then((r) => setPendingIntents(r.pending))
        .catch(() => {});
    poll();
    const t = setInterval(poll, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <Stack>
      {pendingIntents > 0 && (
        <Alert color="yellow" title={`${pendingIntents} agent trade${pendingIntents === 1 ? "" : "s"} awaiting your approval`}>
          An agent proposed a trade gated by safety.tradeApproval. Review the proposal + why it was
          gated on the <b>Approval queue</b> tab, then decide on the CLI:{" "}
          <Code>tradekit intents approve|reject &lt;id&gt;</Code> (approval is CLI-only by design).
        </Alert>
      )}
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
