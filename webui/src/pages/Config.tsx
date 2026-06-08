import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  Code,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { getConfig, postConfig, type ConfigShape, type PageProps } from "../api";

export function ConfigPage({ status: _status }: PageProps) {
  const [cfg, setCfg] = useState<ConfigShape | null>(null);
  const [loading, setLoading] = useState(false);
  const [path, setPath] = useState("");
  const [value, setValue] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getConfig();
      setCfg(r.config);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  async function apply() {
    if (!path) return;
    try {
      const r = await postConfig(path, value);
      setCfg(r.config);
      setPath("");
      setValue("");
      notifications.show({ color: "green", message: `Updated ${path}` });
    } catch (e) {
      const err = e as Error & { code?: string };
      notifications.show({ color: "red", title: err.code ?? "Error", message: err.message });
    }
  }

  if (loading && !cfg) return <Loader size="sm" />;
  if (!cfg) return null;

  return (
    <Stack>
      <Card withBorder>
        <Text fw={600} mb="xs">Update</Text>
        <Group align="end">
          <TextInput
            label="Path"
            placeholder="safety.perTxUsdLimit"
            value={path}
            onChange={(e) => setPath(e.currentTarget.value)}
            w={300}
          />
          <TextInput
            label="Value"
            placeholder='"max" or 100 or {"a":1}'
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            w={300}
          />
          <Button onClick={apply}>Save</Button>
        </Group>
        <Text size="xs" c="dimmed" mt="xs">
          Value is JSON-parsed if it parses; otherwise treated as a raw string.
        </Text>
      </Card>
      <Card withBorder>
        <Group justify="space-between" mb="xs">
          <Text fw={600}>Current config</Text>
          <Button size="xs" variant="light" onClick={refresh} loading={loading}>Refresh</Button>
        </Group>
        <Textarea
          autosize
          readOnly
          value={JSON.stringify(cfg, null, 2)}
          ff="monospace"
          minRows={10}
          maxRows={40}
        />
        <Text size="xs" c="dimmed" mt="xs">Config file: <Code>~/.tradekit/config.json</Code></Text>
      </Card>
    </Stack>
  );
}
