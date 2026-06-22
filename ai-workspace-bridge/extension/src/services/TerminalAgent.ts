import { spawn } from "child_process";

export interface TerminalRunResult {
  exitCode: number | null;
  output: string;
  stdout: string;
  stderr: string;
  transcript: string;
  timedOut: boolean;
}

export class TerminalAgent {
  public async run(
    command: string,
    cwd: string,
    timeoutMs = 60000,
    maxOutput = 20000,
    stdin?: string,
    onChunk?: (chunk: string) => void
  ): Promise<TerminalRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        cwd,
        windowsHide: true
      });

      let output = "";
      let stdout = "";
      let stderr = "";
      const transcript: string[] = [];
      let timedOut = false;

      const emit = (chunk: string) => {
        if (onChunk) {
          onChunk(chunk);
        }
      };

      const pushOutput = (text: string, source: "stdout" | "stderr") => {
        if (output.length < maxOutput) {
          output += text;
          if (output.length > maxOutput) {
            output = output.slice(0, maxOutput) + "\n... (output truncated)";
          }
        }

        if (source === "stdout") {
          stdout += text;
        } else {
          stderr += text;
        }

        transcript.push(text.replace(/\r?\n/g, "\n"));
      };

      const append = (source: "stdout" | "stderr", chunk: Buffer | string) => {
        const text = chunk.toString();
        pushOutput(text, source);
        emit(text);
      };

      const header = `PS ${cwd}> ${command}\n`;
      emit(header);
      transcript.push(`PS ${cwd}> ${command}`);

      if (typeof stdin === "string" && stdin.length > 0) {
        const stdinLine = stdin.replace(/\r?\n$/, "");
        emit(`${stdinLine}\n`);
        transcript.push(stdinLine);
      }

      const timer = setTimeout(() => {
        timedOut = true;
        emit(`\n✗ Timed out after ${timeoutMs}ms\n`);
        transcript.push(`✗ Timed out after ${timeoutMs}ms`);
        child.kill();
      }, timeoutMs);

      child.stdout.on("data", (chunk) => append("stdout", chunk));
      child.stderr.on("data", (chunk) => append("stderr", chunk));

      if (typeof stdin === "string") {
        child.stdin.write(stdin);
        if (!stdin.endsWith("\n")) {
          child.stdin.write("\n");
        }
        child.stdin.end();
      }

      child.on("error", (err) => {
        clearTimeout(timer);
        const message = `✗ Error: ${err instanceof Error ? err.message : String(err)}`;
        emit(`\n${message}\n`);
        transcript.push(message);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        const footer = code === 0 ? "✓ Exit code 0" : `✗ Exit code ${code ?? "unknown"}`;
        emit(`\n${footer}\n`);
        transcript.push(footer);
        resolve({ exitCode: code, output, stdout, stderr, transcript: transcript.join("\n"), timedOut });
      });
    });
  }
}
