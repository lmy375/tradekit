import { useEffect, useRef, useState } from "react";
import { Button, Card, Group, Select, TextInput } from "@mantine/core";
import { createChart, type IChartApi, type ISeriesApi } from "lightweight-charts";
import type { PageProps } from "../api";

const BARS = ["1m", "5m", "15m", "30m", "1H", "4H", "1D", "1W"];

export function Chart({ status: _status }: PageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [symbol, setSymbol] = useState("ETH-USDT");
  const [bar, setBar] = useState("1H");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#0a0d12" }, textColor: "#e6edf3" },
      grid: { vertLines: { color: "#1f242c" }, horzLines: { color: "#1f242c" } },
      timeScale: { timeVisible: true, borderColor: "#30363d" },
      rightPriceScale: { borderColor: "#30363d" },
      height: 480,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#3fb950",
      downColor: "#f85149",
      borderUpColor: "#3fb950",
      borderDownColor: "#f85149",
      wickUpColor: "#3fb950",
      wickDownColor: "#f85149",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
    };
  }, []);

  async function load() {
    if (!seriesRef.current) return;
    setBusy(true);
    try {
      const r = await fetch(
        `/api/candles?instId=${encodeURIComponent(symbol)}&bar=${bar}&limit=300`,
      );
      const body = (await r.json()) as { data?: string[][] };
      const candles = (body.data ?? [])
        .map((row) => ({
          time: Math.floor(parseInt(row[0], 10) / 1000),
          open: parseFloat(row[1]),
          high: parseFloat(row[2]),
          low: parseFloat(row[3]),
          close: parseFloat(row[4]),
        }))
        .sort((a, b) => a.time - b.time);
      // viem types are happy; lightweight-charts time is UTCTimestamp (number of seconds)
      seriesRef.current.setData(candles as Parameters<typeof seriesRef.current.setData>[0]);
      chartRef.current?.timeScale().fitContent();
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card withBorder>
      <Group mb="sm">
        <TextInput value={symbol} onChange={(e) => setSymbol(e.currentTarget.value)} w={140} />
        <Select value={bar} onChange={(v) => v && setBar(v)} data={BARS} w={100} />
        <Button onClick={load} loading={busy}>
          Load
        </Button>
      </Group>
      <div ref={containerRef} style={{ width: "100%" }} />
    </Card>
  );
}
