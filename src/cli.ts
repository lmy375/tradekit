import { createInterface } from "readline";

export function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  // Explicit SIGINT handler: by default readline lets Node's signal handler kill the
  // process abruptly, sometimes mid-write to stderr. Close the readline interface
  // first so the terminal is restored cleanly, then exit with the conventional
  // 128 + SIGINT (2) = 130.
  rl.on("SIGINT", () => {
    rl.close();
    process.stderr.write("\n");
    process.exit(130);
  });
  return new Promise((resolve, reject) => {
    let answered = false;
    // Iter260: handle stdin closing BEFORE an answer is received. Without this, a
    // command like `tradekit wallet create < /dev/null` (or any Docker/CI entrypoint
    // without a TTY) silently hangs forever waiting on a closed stream. Now we throw
    // INVALID_PARAMS with the prompt text so operators can see exactly what was being
    // asked. The standard piped-input case (`echo yes | tradekit ...`) still works
    // because readline calls question() BEFORE the 'close' event fires.
    rl.on("close", () => {
      if (!answered) {
        reject(new Error(`prompt aborted: stdin closed before "${question.trim()}" was answered. Re-run interactively, or pre-answer via --yes / --pass / WALLET_PASS as appropriate.`));
      }
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Control byte constants for raw-mode keystroke handling. Spelled out by name so
// future maintainers don't have to decode literal control chars in the source.
const ETX = 0x03; // Ctrl-C (end of text)
const EOT = 0x04; // Ctrl-D (end of transmission)
const BS = 0x08; // Backspace
const LF = 0x0a; // \n
const CR = 0x0d; // \r
const DEL = 0x7f; // DEL (most terminals send this for the Backspace key)

/**
 * Read a secret from stdin without echoing. Each byte of the incoming data buffer is
 * processed individually — pre-iter139 the handler did strict string-equality compares
 * against single-char strings ("\n", Ctrl-C, etc.) which broke pasted input: when the
 * terminal delivered "word1 word2 ... word12\n" as a single buffer, the whole buffer
 * (including the trailing newline) got appended to the password instead of submitting.
 * That made the no-echo mnemonic prompt unusable for the common paste-the-mnemonic
 * workflow.
 */
export function promptPassword(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Iter260: require a TTY for no-echo input. setRawMode only exists on TTY streams;
    // calling it on a non-TTY stdin (piped input, /dev/null, CI without allocated tty)
    // throws `setRawMode is not a function`. Catch that explicitly with a friendlier
    // message and a hint about the env-var/flag alternatives. Bonus: avoids the
    // half-initialized state where setRawMode succeeds but then bytes can't be read.
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
      reject(new Error(`Cannot prompt for "${question.trim()}" — no interactive terminal. Re-run from a TTY, or supply the secret via --pass / WALLET_PASS / similar non-interactive flag.`));
      return;
    }
    process.stderr.write(question);
    const raw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    // Accumulate as bytes (not String) so multi-byte UTF-8 passwords aren't split
    // mid-codepoint when the terminal delivers them across multiple data events.
    // Decode to a string only at submit time.
    let acc: number[] = [];
    let done = false;
    const cleanup = () => {
      process.stdin.setRawMode(raw ?? false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };
    const submit = () => {
      if (done) return;
      done = true;
      cleanup();
      process.stderr.write("\n");
      resolve(Buffer.from(acc).toString("utf8"));
    };
    const abort = () => {
      if (done) return;
      done = true;
      cleanup();
      process.stderr.write("\n");
      // SIGINT convention: 128 + signal number. Lets shell scripts checking $? see "user cancelled".
      process.exit(130);
    };

    const onData = (buf: Buffer) => {
      for (let i = 0; i < buf.length && !done; i++) {
        const b = buf[i];
        if (b === ETX) {
          // Ctrl-C — abort without revealing what was typed so far.
          abort();
          return;
        }
        if (b === LF || b === CR || b === EOT) {
          // Enter / Ctrl-D — submit. Subsequent bytes in this buffer (rare) are dropped,
          // matching terminal "you pressed enter, command starts now" semantics.
          submit();
          return;
        }
        if (b === BS || b === DEL) {
          // Walk back past any UTF-8 continuation bytes (0x80–0xBF) so deleting one
          // visible char doesn't leave a dangling continuation that breaks decode.
          while (acc.length > 0 && (acc[acc.length - 1] & 0xc0) === 0x80) acc.pop();
          if (acc.length > 0) acc.pop();
          continue;
        }
        // Skip other control chars (< 0x20) — typing them shouldn't end up in the secret.
        // The handled cases above already cover the meaningful ones.
        if (b < 0x20) continue;
        acc.push(b);
      }
    };
    process.stdin.on("data", onData);
  });
}
