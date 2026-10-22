/**
 * Minimal passive-mode FTP client, used only to RETR a finished report's file. Newegg answers
 * file reports with `ftp://{user}:{password}@ftp03.newegg.com/{file}` (contracts §17.5); Node's
 * `fetch` has no FTP support. Binary-mode RETR over a passive data connection to the SAME host
 * as the control connection (the host in a PASV reply is never trusted, so a hostile reply
 * cannot redirect the transfer). Credentials never appear in errors or logs.
 *
 * Transport security (T-5668): explicit FTPS (RFC 4217). The control connection is upgraded with
 * `AUTH TLS` BEFORE `USER`/`PASS` is sent, the certificate is verified against the URL host, and
 * the data channel is protected (`PROT P`, with the control session offered for reuse). There is
 * no plaintext fallback: a server that does not offer FTPS fails the download, and only the
 * explicit {@link FtpDownloadOptions.allowPlaintext} opt-out skips TLS. The URL port is
 * restricted to {@link DEFAULT_ALLOWED_PORTS} so a hostile report response cannot aim the client
 * at another TCP port. The control channel is bounded (T-5669): see {@link MAX_CONTROL_LINE_BYTES}.
 */
import net from "node:net";
import tls from "node:tls";
import { NeweggApiError } from "../errors/index.js";
import { abortReason } from "../util.js";

/** Default allow-list: Newegg's report FTP hosts (e.g. `ftp03.newegg.com`). */
const DEFAULT_ALLOWED_HOST = /(^|\.)newegg\.com$/i;

/** Default allow-list of URL ports: the standard FTP control port only. */
const DEFAULT_ALLOWED_PORTS: readonly number[] = [21];

/** Longest single control-channel line accepted, bytes. A longer line destroys the connection. */
const MAX_CONTROL_LINE_BYTES = 64 * 1024;
/** Most bytes accepted for one (multi-line) reply, bytes. */
const MAX_CONTROL_REPLY_BYTES = 256 * 1024;
/** Most complete replies buffered while no command is waiting for one. */
const MAX_PENDING_REPLIES = 64;

export interface FtpDownloadOptions {
  signal?: AbortSignal;
  /** Hard cap on the downloaded size; the transfer is aborted beyond it. */
  maxBytes: number;
  /** Overall budget for connect + login + transfer, ms. */
  timeoutMs: number;
  /** Hosts the downloader may connect to. Defaults to `*.newegg.com`. */
  allowedHost?: RegExp;
  /**
   * URL ports the downloader may connect to. Defaults to `[21]`; a URL without a port means 21.
   * Any other port is refused before a connection is opened.
   */
  allowedPorts?: readonly number[];
  /**
   * Extra trusted CA certificate(s) (PEM) for the FTPS handshake, on top of Node's defaults.
   * Certificate verification is never disabled.
   */
  tlsCa?: string | Buffer | ReadonlyArray<string | Buffer>;
  /**
   * Explicit opt-out of FTPS: skips `AUTH TLS` and sends the credentials and the report in
   * clear text. Off by default; there is no automatic fallback to it.
   */
  allowPlaintext?: boolean;
}

interface Reply {
  code: number;
  text: string;
}

function fail(
  stage: string,
  ftpCode?: number,
  cause?: unknown,
  extra: Record<string, unknown> = {},
): NeweggApiError {
  return new NeweggApiError(
    `Report file download failed during ${stage}${ftpCode !== undefined ? ` (FTP ${ftpCode})` : ""}.`,
    {
      retryable: false,
      details: { stage, ...(ftpCode !== undefined ? { ftpCode } : {}), ...extra },
      cause,
    },
  );
}

/** Reads FTP replies (single and multi-line) off a control socket, with bounded buffering. */
class ControlChannel {
  readonly #socket: net.Socket;
  #buffer = "";
  #pending: Reply[] = [];
  #multiline: string | undefined;
  #multilineBytes = 0;
  #waiter: { resolve: (reply: Reply) => void; reject: (error: unknown) => void } | undefined;
  #error: unknown;
  readonly #onData = (chunk: string): void => this.#handleData(chunk);
  readonly #onError = (error: unknown): void => this.#fail(error);
  readonly #onClose = (): void => this.#fail(new Error("control connection closed"));

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.setEncoding("latin1");
    socket.on("data", this.#onData);
    socket.on("error", this.#onError);
    socket.on("close", this.#onClose);
  }

  /**
   * Stops reading the socket so it can be handed to TLS. Returns false when anything was received
   * but not yet consumed: bytes that follow the `AUTH TLS` reply in clear text are a
   * command-injection attempt and must abort the upgrade.
   */
  detach(): boolean {
    this.#socket.off("data", this.#onData);
    this.#socket.off("error", this.#onError);
    this.#socket.off("close", this.#onClose);
    // Errors after the hand-over surface on the TLS socket; keep this one from crashing.
    this.#socket.on("error", () => undefined);
    return this.#buffer === "" && this.#pending.length === 0 && this.#multiline === undefined;
  }

  #fail(error: unknown): void {
    this.#error ??= error;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.reject(this.#error);
  }

  #overflow(): void {
    this.#buffer = "";
    this.#fail(fail("control channel (reply exceeds the size limit)"));
    this.#socket.destroy();
  }

  #handleData(chunk: string): void {
    if (this.#error !== undefined) return;
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      if (index > MAX_CONTROL_LINE_BYTES) {
        this.#overflow();
        return;
      }
      const line = this.#buffer.slice(0, index).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(index + 1);
      if (!this.#onLine(line)) {
        this.#overflow();
        return;
      }
      index = this.#buffer.indexOf("\n");
    }
    if (this.#buffer.length > MAX_CONTROL_LINE_BYTES) this.#overflow();
  }

  /** Returns false when a size limit was exceeded. */
  #onLine(line: string): boolean {
    const match = /^(\d{3})([ -])/.exec(line);
    if (this.#multiline !== undefined) {
      this.#multilineBytes += line.length + 1;
      if (this.#multilineBytes > MAX_CONTROL_REPLY_BYTES) return false;
      // Inside a multi-line reply only "<code><space>" terminates it.
      if (match && match[1] === this.#multiline && match[2] === " ") {
        this.#deliver({ code: Number(match[1]), text: line.slice(4) });
        this.#multiline = undefined;
        this.#multilineBytes = 0;
      }
      return true;
    }
    if (!match) return true;
    if (match[2] === "-") {
      this.#multiline = match[1];
      this.#multilineBytes = line.length + 1;
      return true;
    }
    this.#deliver({ code: Number(match[1]), text: line.slice(4) });
    return this.#pending.length <= MAX_PENDING_REPLIES;
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

interface TlsSettings {
  readonly host: string;
  readonly ca: FtpDownloadOptions["tlsCa"];
}

function extraCa(ca: NonNullable<FtpDownloadOptions["tlsCa"]>): Array<string | Buffer> {
  return typeof ca === "string" || Buffer.isBuffer(ca) ? [ca] : [...ca];
}

function tlsOptions(settings: TlsSettings, session?: Buffer): tls.ConnectionOptions {
  return {
    // Certificate verification stays ON (Node default); only extra trust anchors are added.
    host: settings.host,
    // SNI must not be an IP literal (RFC 6066); verification still checks the IP SAN.
    ...(net.isIP(settings.host) === 0 ? { servername: settings.host } : {}),
    ...(settings.ca === undefined
      ? {}
      : { ca: [...tls.rootCertificates, ...extraCa(settings.ca)] }),
    ...(session === undefined ? {} : { session }),
    minVersion: "TLSv1.2",
  };
}

/** Wraps an established TCP socket in TLS and resolves once the handshake verified the peer. */
function upgrade(socket: net.Socket, options: tls.ConnectionOptions): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const secure = tls.connect({ ...options, socket });
    secure.once("secureConnect", () => resolve(secure));
    secure.once("error", reject);
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

function tlsErrorCode(error: unknown): Record<string, unknown> {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? { tlsError: code } : {};
}

/**
 * Downloads one file from an `ftp://user:pass@host/path` URL over explicit FTPS. Throws
 * {@link NeweggApiError} (never containing the URL) on a disallowed host or port, a missing or
 * failed TLS upgrade, a protocol error, a size breach, or a timeout.
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
  const port = parsed.port === "" ? 21 : Number(parsed.port);
  if (!(options.allowedPorts ?? DEFAULT_ALLOWED_PORTS).includes(port)) {
    throw fail("port validation (port is not an allowed report file port)");
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
    const settings: TlsSettings = { host: parsed.hostname, ca: options.tlsCa };
    let controlSocket: net.Socket;
    try {
      controlSocket = await connect(parsed.hostname, port);
    } catch (error) {
      throw fail("connect", undefined, error);
    }
    sockets.push(controlSocket);
    let control = new ControlChannel(controlSocket);
    // Resolved before the upgrade: TLS and the PASV peer pin the address we actually connected to.
    const peer = controlSocket.remoteAddress ?? parsed.hostname;
    let controlTls: tls.TLSSocket | undefined;

    await expect(control, "greeting", (code) => code === 220);

    if (options.allowPlaintext !== true) {
      control.send("AUTH TLS");
      const answer = await control.reply();
      if (answer.code !== 234) {
        throw fail("TLS upgrade (server does not offer FTPS, nothing was sent)", answer.code);
      }
      if (!control.detach()) throw fail("TLS upgrade (unexpected data before the handshake)");
      try {
        controlTls = await upgrade(controlSocket, tlsOptions(settings));
      } catch (error) {
        throw fail("TLS handshake (certificate or protocol error)", undefined, error, {
          ...tlsErrorCode(error),
        });
      }
      sockets.push(controlTls);
      control = new ControlChannel(controlTls);
      control.send("PBSZ 0");
      await expect(control, "TLS setup", (code) => code === 200);
      control.send("PROT P");
      await expect(control, "TLS setup", (code) => code === 200);
    }

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
    const dataPort = passivePort(reply);
    if (dataPort === undefined) throw fail("passive mode setup (unparseable reply)");

    let dataSocket: net.Socket;
    try {
      dataSocket = await connect(peer, dataPort);
    } catch (error) {
      throw fail("data connection", undefined, error);
    }
    sockets.push(dataSocket);
    let transferSocket: net.Socket = dataSocket;
    if (controlTls !== undefined) {
      // The handshake runs while RETR is being sent: some servers only start theirs after the
      // transfer command. Reusing the control session satisfies servers that require it.
      const secureData = tls.connect({
        ...tlsOptions(settings, controlTls.getSession() ?? undefined),
        socket: dataSocket,
      });
      sockets.push(secureData);
      transferSocket = secureData;
    }
    const transfer = collect(transferSocket, options.maxBytes);
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
