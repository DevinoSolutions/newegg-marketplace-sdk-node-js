/**
 * Minimal passive-mode FTP client, used only to RETR a finished report's file. Newegg answers
 * file reports with `ftp://{user}:{password}@ftp03.newegg.com/{file}` (contracts §17.5); Node's
 * `fetch` has no FTP support. Binary-mode RETR over a passive data connection to the SAME host
 * as the control connection (the host in a PASV reply is never trusted, so a hostile reply
 * cannot redirect the transfer). Credentials never appear in errors or logs.
 */
import net from "node:net";
import { NeweggApiError } from "../errors/index.js";
import { abortReason } from "../util.js";

/** Default allow-list: Newegg's report FTP hosts (e.g. `ftp03.newegg.com`). */
const DEFAULT_ALLOWED_HOST = /(^|\.)newegg\.com$/i;

export interface FtpDownloadOptions {
  signal?: AbortSignal;
  /** Hard cap on the downloaded size; the transfer is aborted beyond it. */
  maxBytes: number;
  /** Overall budget for connect + login + transfer, ms. */
  timeoutMs: number;
  /** Hosts the downloader may connect to. Defaults to `*.newegg.com`. */
  allowedHost?: RegExp;
}

interface Reply {
  code: number;
  text: string;
}

function fail(stage: string, ftpCode?: number, cause?: unknown): NeweggApiError {
  return new NeweggApiError(
    `Report file download failed during ${stage}${ftpCode !== undefined ? ` (FTP ${ftpCode})` : ""}.`,
    { retryable: false, details: { stage, ...(ftpCode !== undefined ? { ftpCode } : {}) }, cause },
  );
}

/** Reads FTP replies (single and multi-line) off a control socket. */
class ControlChannel {
  readonly #socket: net.Socket;
  #buffer = "";
  #pending: Reply[] = [];
  #multiline: string | undefined;
  #waiter: { resolve: (reply: Reply) => void; reject: (error: unknown) => void } | undefined;
  #error: unknown;

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => this.#onData(chunk));
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => this.#fail(new Error("control connection closed")));
  }

  #fail(error: unknown): void {
    this.#error ??= error;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.reject(this.#error);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(index + 1);
      this.#onLine(line);
      index = this.#buffer.indexOf("\n");
    }
  }

  #onLine(line: string): void {
    const match = /^(\d{3})([ -])/.exec(line);
    if (this.#multiline !== undefined) {
      // Inside a multi-line reply only "<code><space>" terminates it.
      if (match && match[1] === this.#multiline && match[2] === " ") {
        this.#deliver({ code: Number(match[1]), text: line.slice(4) });
        this.#multiline = undefined;
      }
      return;
    }
    if (!match) return;
    if (match[2] === "-") {
      this.#multiline = match[1];
      return;
    }
    this.#deliver({ code: Number(match[1]), text: line.slice(4) });
  }

  #deliver(reply: Reply): void {
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter.resolve(reply);
    } else {
      this.#pending.push(reply);
    }
  }

  reply(): Promise<Reply> {
    const queued = this.#pending.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#error !== undefined) return Promise.reject(this.#error);
    return new Promise<Reply>((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  send(command: string): void {
    this.#socket.write(`${command}\r\n`);
  }
}

function connect(host: string, port: number): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function expect(
  control: ControlChannel,
  stage: string,
  ok: (code: number) => boolean,
): Promise<Reply> {
  const reply = await control.reply();
  if (!ok(reply.code)) throw fail(stage, reply.code);
  return reply;
}

function passivePort(reply: Reply): number | undefined {
  const pasv = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(reply.text);
  if (pasv) return Number(pasv[5]) * 256 + Number(pasv[6]);
  const epsv = /\(\|\|\|(\d+)\|\)/.exec(reply.text);
  return epsv ? Number(epsv[1]) : undefined;
}

function collect(socket: net.Socket, maxBytes: number): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        socket.destroy();
        reject(fail("transfer (file exceeds the size limit)"));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => resolve(Buffer.concat(chunks)));
    socket.once("error", reject);
  });
}

/**
 * Downloads one file from an `ftp://user:pass@host/path` URL. Throws {@link NeweggApiError}
 * (never containing the URL) on a disallowed host, protocol error, size breach, or timeout.
 */
export async function downloadViaFtp(
  url: string,
  options: FtpDownloadOptions,
): Promise<Uint8Array> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw fail("URL parsing");
  }
  if (parsed.protocol !== "ftp:") throw fail("URL validation (not an ftp URL)");
  const allowed = options.allowedHost ?? DEFAULT_ALLOWED_HOST;
  if (!allowed.test(parsed.hostname)) {
    throw fail("host validation (host is not an allowed report file host)");
  }
  const user = decodeURIComponent(parsed.username || "anonymous");
  const password = decodeURIComponent(parsed.password || "anonymous@");
  const path = decodeURIComponent(parsed.pathname).replace(/^\//, "");
  if (path === "" || /[\r\n]/.test(path) || /[\r\n]/.test(user) || /[\r\n]/.test(password)) {
    throw fail("URL validation");
  }

  const sockets: net.Socket[] = [];
  const cleanup = (): void => {
    for (const socket of sockets) socket.destroy();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cleanup();
      reject(fail("transfer (timed out)"));
    }, options.timeoutMs);
    if (options.signal) {
      onAbort = () => {
        cleanup();
        reject(abortReason(options.signal));
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  const work = (async (): Promise<Uint8Array> => {
    let controlSocket: net.Socket;
    try {
      controlSocket = await connect(parsed.hostname, Number(parsed.port) || 21);
    } catch (error) {
      throw fail("connect", undefined, error);
    }
    sockets.push(controlSocket);
    const control = new ControlChannel(controlSocket);
    const peer = controlSocket.remoteAddress ?? parsed.hostname;

    await expect(control, "greeting", (code) => code === 220);
    control.send(`USER ${user}`);
    const afterUser = await expect(control, "login", (code) => code === 230 || code === 331);
    if (afterUser.code === 331) {
      control.send(`PASS ${password}`);
      await expect(control, "login", (code) => code === 230);
    }
    control.send("TYPE I");
    await expect(control, "transfer setup", (code) => code === 200);

    control.send("PASV");
    let reply = await control.reply();
    if (reply.code !== 227) {
      control.send("EPSV");
      reply = await control.reply();
      if (reply.code !== 229) throw fail("passive mode setup", reply.code);
    }
    const port = passivePort(reply);
    if (port === undefined) throw fail("passive mode setup (unparseable reply)");

    let dataSocket: net.Socket;
    try {
      dataSocket = await connect(peer, port);
    } catch (error) {
      throw fail("data connection", undefined, error);
    }
    sockets.push(dataSocket);
    const transfer = collect(dataSocket, options.maxBytes);
    // `transfer` can reject before we await it below; attach a handler so that is not unhandled.
    transfer.catch(() => undefined);

    control.send(`RETR ${path}`);
    await expect(control, "file retrieval", (code) => code === 125 || code === 150);
    const bytes = await transfer;
    await expect(control, "transfer completion", (code) => code === 226 || code === 250);
    control.send("QUIT");
    return bytes;
  })();

  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    cleanup();
    // The losing branch may still reject after cleanup() destroyed the sockets; swallow it.
    work.catch(() => undefined);
    guard.catch(() => undefined);
  }
}
