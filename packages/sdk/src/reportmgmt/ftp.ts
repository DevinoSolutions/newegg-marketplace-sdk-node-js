/**
 * Minimal passive-mode FTP client, used only to RETR a finished report's file. Newegg answers
 * file reports with `ftp://{user}:{password}@ftp03.newegg.com/{file}` (contracts §17.5); Node's
 * `fetch` has no FTP support. Binary-mode RETR over a passive data connection to the SAME host
 * as the control connection (the host in a PASV reply is never trusted, so a hostile reply
 * cannot redirect the transfer). Credentials never appear in errors or logs.
 *
 * Transport security (T-5668): explicit FTPS (RFC 4217) is OPT-IN (`ftps: true`). Newegg's report
 * server offers `AUTH TLS` but presents a self-signed Serv-U certificate (CN `ftp.Serv-U.com`), so
 * default verification cannot succeed against it; plain FTP therefore stays the default. With
 * `ftps` the control connection is upgraded with `AUTH TLS` BEFORE `USER`/`PASS` is sent, the
 * server is authenticated by the default trust store + host name, by `tlsCa`, or by a pinned
 * certificate fingerprint (`tlsPinnedCertSha256`), and the data channel is protected (`PROT P`).
 * There is never a silent fallback to plain FTP: with `ftps` a server that does not offer TLS, or
 * whose certificate does not verify, fails the download before any credential is sent. The URL
 * port is restricted to {@link DEFAULT_ALLOWED_PORTS} so a hostile report response cannot aim the
 * client at another TCP port. The control channel is bounded (T-5669): see
 * {@link MAX_CONTROL_LINE_BYTES}.
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
   * Opt in to explicit FTPS: `AUTH TLS` before the login, protected data channel. Default false
   * (plain FTP, the only mode Newegg's self-signed certificate allows without a pin). There is no
   * fallback in either direction: with `ftps` a failed upgrade fails the download.
   */
  ftps?: boolean;
  /** FTPS: extra trusted CA certificate(s) (PEM) on top of Node's defaults. */
  tlsCa?: string | Buffer | ReadonlyArray<string | Buffer>;
  /**
   * FTPS: authenticate the server by the SHA-256 fingerprint of its certificate (hex, colons
   * optional) instead of a CA chain and host name. Needed for Newegg's self-signed certificate.
   * The first fingerprint has to be obtained out of band; a changed certificate fails closed.
   */
  tlsPinnedCertSha256?: string;
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
  #rejectOverflow: (error: unknown) => void = () => undefined;
  /**
   * Rejects when the server breaks a size limit of this channel. Nothing awaits a control reply
   * while a transfer runs, so the transfer waits on this too and ends with the same error.
   */
  readonly overflowed = new Promise<never>((_, reject) => {
    this.#rejectOverflow = reject;
  });
  readonly #onData = (chunk: string): void => this.#handleData(chunk);
  readonly #onError = (error: unknown): void => this.#fail(error);
  readonly #onClose = (): void => this.#fail(new Error("control connection closed"));

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.setEncoding("latin1");
    socket.on("data", this.#onData);
    socket.on("error", this.#onError);
    socket.on("close", this.#onClose);
    this.overflowed.catch(() => undefined);
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
    const error = fail("control channel (reply exceeds the size limit)");
    this.#fail(error);
    this.#rejectOverflow(error);
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
        this.#multiline = undefined;
        this.#multilineBytes = 0;
        return this.#deliver({ code: Number(match[1]), text: line.slice(4) });
      }
      return true;
    }
    if (!match) return true;
    if (match[2] === "-") {
      this.#multiline = match[1];
      this.#multilineBytes = line.length + 1;
      return true;
    }
    return this.#deliver({ code: Number(match[1]), text: line.slice(4) });
  }

  /** Hands a complete reply to the waiting command or queues it; false once too many are queued. */
  #deliver(reply: Reply): boolean {
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter.resolve(reply);
      return true;
    }
    this.#pending.push(reply);
    return this.#pending.length <= MAX_PENDING_REPLIES;
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
  /** Normalized upper-case hex fingerprint, or undefined for CA / host name verification. */
  readonly pin: string | undefined;
}

const normalizeFingerprint = (value: string): string => value.replace(/:/g, "").toUpperCase();

/** True when `socket`'s peer certificate is the pinned one. */
function matchesPin(socket: tls.TLSSocket, pin: string): boolean {
  const presented = socket.getPeerCertificate().fingerprint256;
  return typeof presented === "string" && normalizeFingerprint(presented) === pin;
}

function extraCa(ca: NonNullable<FtpDownloadOptions["tlsCa"]>): Array<string | Buffer> {
  return typeof ca === "string" || Buffer.isBuffer(ca) ? [ca] : [...ca];
}

function tlsOptions(settings: TlsSettings, session?: Buffer): tls.ConnectionOptions {
  return {
    // Without a pin, certificate verification stays ON (Node default); only trust anchors are
    // added. With a pin the chain cannot validate (self-signed), so the fingerprint is checked
    // right after the handshake instead (see `verifyPin`), before anything is sent.
    ...(settings.pin === undefined ? {} : { rejectUnauthorized: false }),
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

/** Destroys `secure` with an error when a pinned certificate is not the one presented. */
function verifyPin(secure: tls.TLSSocket, pin: string | undefined): boolean {
  if (pin === undefined) return true;
  // A resumed session (the data channel reusing the control session) presents no certificate: the
  // resumption secret already proves it is the server whose pinned certificate the control
  // connection verified.
  if (secure.isSessionReused() || matchesPin(secure, pin)) return true;
  secure.destroy(
    Object.assign(new Error("certificate does not match the pin"), { code: "CERT_PIN_MISMATCH" }),
  );
  return false;
}

/** Wraps an established TCP socket in TLS and resolves once the handshake verified the peer. */
function upgrade(
  socket: net.Socket,
  options: tls.ConnectionOptions,
  pin: string | undefined,
): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const secure = tls.connect({ ...options, socket });
    secure.once("secureConnect", () => {
      if (verifyPin(secure, pin)) resolve(secure);
    });
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

/** Whether the data channel's TLS handshake (and pin check) finished; only used in FTPS mode. */
interface DataTlsState {
  handshaken: boolean;
}

function collect(socket: net.Socket, maxBytes: number, secure?: DataTlsState): Promise<Uint8Array> {
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
    socket.once("end", () => {
      // A peer that answers the ClientHello with plain bytes and hangs up must not look like an
      // empty file.
      if (secure !== undefined && !secure.handshaken) {
        reject(fail("data channel TLS (closed before the handshake completed)"));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    socket.once("error", (error: unknown) => {
      if (secure !== undefined) {
        reject(
          fail("data channel TLS (certificate or protocol error)", undefined, error, {
            ...tlsErrorCode(error),
          }),
        );
      } else {
        reject(fail("transfer (data connection error)", undefined, error));
      }
    });
  });
}

/** The byte count of a `213 <size>` reply, or undefined when it is not one plain integer. */
function parseAnnouncedSize(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d{1,15}$/.test(trimmed)) return undefined;
  return Number(trimmed);
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
    const settings: TlsSettings = {
      host: parsed.hostname,
      ca: options.tlsCa,
      pin:
        options.tlsPinnedCertSha256 === undefined
          ? undefined
          : normalizeFingerprint(options.tlsPinnedCertSha256),
    };
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

    if (options.ftps === true) {
      control.send("AUTH TLS");
      const answer = await control.reply();
      if (answer.code !== 234) {
        throw fail("TLS upgrade (server does not offer FTPS, nothing was sent)", answer.code);
      }
      if (!control.detach()) throw fail("TLS upgrade (unexpected data before the handshake)");
      try {
        controlTls = await upgrade(controlSocket, tlsOptions(settings), settings.pin);
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

    // The data channel's end of stream is the only length marker a plain transfer has, and Node's
    // TLS layer does not report a missing close_notify, so a transfer cut short on the wire looks
    // complete. SIZE (RFC 3659, binary mode) gives an independent length to compare against.
    control.send(`SIZE ${path}`);
    const sizeReply = await control.reply();
    const announced = sizeReply.code === 213 ? parseAnnouncedSize(sizeReply.text) : undefined;
    if (announced === undefined && controlTls !== undefined && sizeReply.code !== 550) {
      throw fail(
        "transfer setup (server cannot report the file size, which FTPS needs to detect a truncated transfer)",
        sizeReply.code,
      );
    }
    if (announced !== undefined && announced > options.maxBytes) {
      throw fail("transfer (file exceeds the size limit)");
    }

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
    let dataTls: DataTlsState | undefined;
    if (controlTls !== undefined) {
      // The handshake runs while RETR is being sent: some servers only start theirs after the
      // transfer command. Reusing the control session satisfies servers that require it.
      const secureData = tls.connect({
        ...tlsOptions(settings, controlTls.getSession() ?? undefined),
        socket: dataSocket,
      });
      sockets.push(secureData);
      const state: DataTlsState = { handshaken: false };
      dataTls = state;
      secureData.once("secureConnect", () => {
        state.handshaken = verifyPin(secureData, settings.pin);
      });
      transferSocket = secureData;
    }
    const transfer = collect(transferSocket, options.maxBytes, dataTls);
    // `transfer` can reject before we await it below; attach a handler so that is not unhandled.
    transfer.catch(() => undefined);

    control.send(`RETR ${path}`);
    await expect(control, "file retrieval", (code) => code === 125 || code === 150);
    const bytes = await Promise.race([transfer, control.overflowed]);
    await expect(control, "transfer completion", (code) => code === 226 || code === 250);
    if (announced !== undefined && bytes.length !== announced) {
      throw fail(`transfer (truncated: received ${bytes.length} of ${announced} bytes)`);
    }
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
