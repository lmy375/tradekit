import { createInterface } from "readline";

export function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    const raw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let password = "";
    const onData = (ch: Buffer) => {
      const c = ch.toString("utf8");
      if (c === "\n" || c === "\r" || c === "\u0004") {
        process.stdin.setRawMode(raw ?? false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stderr.write("\n");
        resolve(password);
      } else if (c === "\u0003") {
        // Ctrl+C
        process.exit(1);
      } else if (c === "\u007f" || c === "\b") {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
        }
      } else {
        password += c;
      }
    };
    process.stdin.on("data", onData);
  });
}
