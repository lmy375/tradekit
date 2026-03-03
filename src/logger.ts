import { createWriteStream, mkdirSync, readFileSync, appendFileSync, existsSync } from "fs";
import type { WriteStream } from "fs";
import { DATA_DIR, SERVER_LOG_PATH, TRADE_CSV_PATH } from "./constants.js";
import type { TradeRecord } from "./types.js";

export interface Logger {
  info(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
  recordTrade(record: TradeRecord): void;
  readRecentTrades(n: number): TradeRecord[];
  close(): void;
}

export function createLogger(): Logger {
  mkdirSync(DATA_DIR, { recursive: true });

  const logStream: WriteStream = createWriteStream(SERVER_LOG_PATH, {
    flags: "a",
  });

  // Ensure trade.csv has header
  if (!existsSync(TRADE_CSV_PATH)) {
    appendFileSync(
      TRADE_CSV_PATH,
      "timestamp,direction,base_amount,quote_amount,price,tx_hash,status,gas_used,fee_tier\n",
    );
  }

  function write(level: string, msg: string) {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    logStream.write(line);
    process.stderr.write(line);
  }

  return {
    info: (msg) => write("INFO", msg),
    error: (msg) => write("ERROR", msg),
    debug: (msg) => write("DEBUG", msg),

    recordTrade(record: TradeRecord) {
      const line = [
        record.timestamp,
        record.direction,
        record.baseAmount,
        record.quoteAmount,
        record.price,
        record.txHash,
        record.status,
        record.gasUsed,
        record.feeTier,
      ].join(",");
      appendFileSync(TRADE_CSV_PATH, line + "\n");
    },

    readRecentTrades(n: number): TradeRecord[] {
      try {
        const content = readFileSync(TRADE_CSV_PATH, "utf-8");
        const lines = content.trim().split("\n");
        // Skip header
        const dataLines = lines.slice(1);
        const recent = dataLines.slice(-n);
        return recent.map((line) => {
          const [
            timestamp,
            direction,
            baseAmount,
            quoteAmount,
            price,
            txHash,
            status,
            gasUsed,
            feeTier,
          ] = line.split(",");
          return {
            timestamp,
            direction: direction as "buy" | "sell",
            baseAmount,
            quoteAmount,
            price,
            txHash,
            status,
            gasUsed,
            feeTier: parseInt(feeTier, 10),
          };
        });
      } catch {
        return [];
      }
    },

    close() {
      logStream.end();
    },
  };
}
