import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Card, Group, Loader, Stack, Text } from "@mantine/core";
import { getRisk, type PageProps, type RiskResp, type RiskVerdict } from "../api";

const VERDICT_COLOR: Record<RiskVerdict, string> = {
  ok: "teal",
  elevated: "yellow",
  critical: "red",
};
const SOURCE_LABEL: Record<string, string> = {
  headroom: "exposure",
  concentration: "concentration",
  protection: "unprotected",
  mev: "MEV",
};

export function Risk({ status: _status }: PageProps) {
  const [data, setData] = useState<RiskResp | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getRisk());
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  if (!data) return loading ? <Loader size="sm" /> : null;

  return (
    <Stack>
      <Group justify="space-between">
        <Text c="dimmed" size="sm">
          Unified runtime risk — exposure headroom, concentration, unprotected value, and MEV,
          synthesized into one verdict. The single "is my book in danger right now?" read.
        </Text>
        <Badge color={VERDICT_COLOR[data.verdict]} size="lg" variant="filled">
          {data.verdict}
        </Badge>
      </Group>

      <Card withBorder padding="sm">
        <Text size="sm">{data.summary}</Text>
      </Card>

      {data.concerns.length === 0 ? (
        <Text c="dimmed">No elevated or critical concerns.</Text>
      ) : (
        <Stack gap={6}>
          {data.concerns.map((c, i) => (
            <Alert
              key={i}
              color={c.severity === "critical" ? "red" : "yellow"}
              variant="light"
              title={
                <Group gap={6}>
                  <Badge size="sm" color={c.severity === "critical" ? "red" : "yellow"} variant="filled">
                    {c.severity === "critical" ? "CRITICAL" : "elevated"}
                  </Badge>
                  <Badge size="sm" variant="outline">{SOURCE_LABEL[c.source] ?? c.source}</Badge>
                </Group>
              }
            >
              <Text size="sm">{c.message}</Text>
            </Alert>
          ))}
        </Stack>
      )}

      <Text size="xs" c="dimmed">
        Checked: {data.checked.join(", ") || "none"}
        {data.skipped.length > 0 ? ` · skipped: ${data.skipped.join(", ")} (run \`risk\` on the CLI for the full picture)` : ""}
      </Text>
    </Stack>
  );
}
