import { X509Certificate } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { NeweggApiError } from "../src/errors/index.js";
import { downloadViaFtp } from "../src/reportmgmt/ftp.js";
import { makeTlsFixture, type TlsFixture } from "./tls-fixture.js";

// T-5668 (L4): the report download must not be plaintext and must not follow an attacker-chosen
// port. T-5669 (L5): the control channel must not buffer without bound.

const ANY_HOST = /.*/;
const FIXTURE = makeTlsFixture();

interface SeenCommand {
  readonly verb: string;
  /** Whether the command arrived over the upgraded (TLS) control channel. */
  readonly secure: boolean;
}

interface Stub {
  port: number;
  readonly commands: SeenCommand[];
  connections: number;
  dataChannelSecure: boolean | undefined;
  close(): Promise<void>;
}

interface StubOptions {
  files?: Record<string, Buffer>;
  /** Offer explicit FTPS (AUTH TLS) with this certificate; omit for a plaintext-only server. */
  tls?: TlsFixture;
  /** Answer SIZE with the real length of the file (default); false makes SIZE "not implemented". */
  supportSize?: boolean;
  /** Answer SIZE with this length whatever the file really is. */
  sizeReply?: number;
  /** Send only this many bytes of the file, then drop the data connection without closing TLS. */
  truncateTo?: number;
  /** Serve plain bytes on the data port even after PROT P, so the client's TLS handshake fails. */
  brokenDataTls?: boolean;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function startStub(options: StubOptions = {}): Promise<Stub> {
  const files = options.files ?? {};
  const sockets = new Set<net.Socket>();
  const stub: Stub = {
    port: 0,
    commands: [],
    connections: 0,
    dataChannelSecure: undefined,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  const server = net.createServer((raw) => {
    stub.connections += 1;
    sockets.add(raw);
    raw.on("error", () => undefined);
    let protectData = false;
    let dataServer: net.Server | undefined;
    let dataSocketReady: Promise<net.Socket> | undefined;

    const attach = (socket: net.Socket): void => {
      let buffer = "";
      socket.on("error", () => undefined);
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("latin1");
        let index = buffer.indexOf("\r\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf("\r\n");
          handle(socket, line);
        }
      });
    };

    const handle = (socket: net.Socket, line: string): void => {
      const [verb = "", ...rest] = line.split(" ");
      const arg = rest.join(" ");
      stub.commands.push({ verb, secure: socket instanceof tls.TLSSocket });
      switch (verb) {
        case "AUTH":
          if (options.tls === undefined) {
            socket.write("502 AUTH not supported\r\n");
          } else {
            socket.write("234 AUTH TLS ok\r\n");
            raw.removeAllListeners("data");
            const secure = new tls.TLSSocket(raw, {
              isServer: true,
              key: options.tls.key,
              cert: options.tls.cert,
            });
            sockets.add(secure);
            attach(secure);
          }
          return;
        case "PBSZ":
          socket.write("200 PBSZ=0\r\n");
          return;
        case "PROT":
          protectData = arg === "P";
          socket.write("200 PROT ok\r\n");
          return;
        case "USER":
          socket.write("331 password please\r\n");
          return;
        case "PASS":
          socket.write("230 ok\r\n");
          return;
        case "TYPE":
          socket.write("200 binary\r\n");
          return;
        case "PASV": {
          const secureData =
            protectData && options.tls !== undefined && options.brokenDataTls !== true;
          dataServer = secureData
            ? tls.createServer({ key: options.tls?.key, cert: options.tls?.cert })
            : net.createServer();
          dataSocketReady = new Promise((resolve) => {
            dataServer?.once(secureData ? "secureConnection" : "connection", (data: net.Socket) => {
              stub.dataChannelSecure = data instanceof tls.TLSSocket;
              sockets.add(data);
              data.on("error", () => undefined);
              resolve(data);
            });
          });
          dataServer.listen(0, "127.0.0.1", () => {
            const port = (dataServer?.address() as net.AddressInfo).port;
            socket.write(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})\r\n`);
          });
          return;
        }
        case "SIZE": {
          const file = files[arg];
          if (options.sizeReply !== undefined) {
            socket.write(`213 ${options.sizeReply}\r\n`);
          } else if (options.supportSize !== false && file !== undefined) {
            socket.write(`213 ${file.length}\r\n`);
          } else {
            socket.write("502 not implemented\r\n");
          }
          return;
        }
        case "RETR": {
          const file = files[arg];
          if (file === undefined) {
            socket.write("550 no such file\r\n");
            return;
          }
          socket.write("150 opening\r\n");
          void dataSocketReady?.then((data) => {
            if (options.truncateTo !== undefined) {
              data.write(file.subarray(0, options.truncateTo), () => {
                data.destroy();
                socket.write("226 done\r\n");
                dataServer?.close();
              });
              return;
            }
            data.end(file, () => {
              socket.write("226 done\r\n");
              dataServer?.close();
            });
          });
          return;
        }
        case "QUIT":
          socket.end("221 bye\r\n");
          return;
        default:
          socket.write("502 not implemented\r\n");
      }
    };

    raw.write("220 stub ready\r\n");
    attach(raw);
    raw.on("close", () => sockets.delete(raw));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.port = (server.address() as net.AddressInfo).port;
  closers.push(stub.close);
  return stub;
}

const verbs = (stub: Stub): string[] => stub.commands.map((command) => command.verb);

describe("FTP report download is not plaintext and not port-hopping (T-5668 / L4)", () => {
  it("refuses a URL port other than 21 by default, before connecting", async () => {
    const stub = await startStub();
    const error = await downloadViaFtp(`ftp://user:pw@127.0.0.1:${stub.port}/x.csv`, {
      maxBytes: 1024,
      timeoutMs: 3000,
      allowedHost: ANY_HOST,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as Error).message).toMatch(/port/);
    expect(stub.connections).toBe(0);
    expect(JSON.stringify(error)).not.toContain("pw");
  });

  it("connects to a non-default port only when it is explicitly allowed", async () => {
    const stub = await startStub({ tls: FIXTURE, files: { "x.csv": Buffer.from("a,b\n1,2\n") } });
    const bytes = await downloadViaFtp(`ftp://user:pw@127.0.0.1:${stub.port}/x.csv`, {
      maxBytes: 1024,
      timeoutMs: 5000,
      allowedHost: ANY_HOST,
      allowedPorts: [stub.port],
      ftps: true,
      tlsCa: FIXTURE.cert,
    });
    expect(Buffer.from(bytes).toString()).toBe("a,b\n1,2\n");
  });

  it("never sends credentials to a server that does not offer FTPS", async () => {
    const stub = await startStub({ files: { "x.csv": Buffer.from("secret rows") } });
    const error = await downloadViaFtp(`ftp://user:pw@127.0.0.1:${stub.port}/x.csv`, {
      maxBytes: 1024,
      timeoutMs: 3000,
      allowedHost: ANY_HOST,
      allowedPorts: [stub.port],
      ftps: true,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as Error).message).toMatch(/TLS|FTPS/);
    expect(verbs(stub)).not.toContain("USER");
    expect(verbs(stub)).not.toContain("PASS");
    expect(JSON.stringify(error)).not.toContain("pw");
  });

  it("logs in, authenticates and transfers over TLS (control and data channel)", async () => {
    const payload = Buffer.from("Seller Part #,NE Item #\nA1,9SI1\n");
    const stub = await startStub({ tls: FIXTURE, files: { "report.csv": payload } });
    const bytes = await downloadViaFtp(`ftp://user:pw@127.0.0.1:${stub.port}/report.csv`, {
      maxBytes: 1024,
      timeoutMs: 5000,
      allowedHost: ANY_HOST,
      allowedPorts: [stub.port],
      ftps: true,
      tlsCa: FIXTURE.cert,
    });
    expect(Buffer.from(bytes).toString()).toBe(payload.toString());
    expect(verbs(stub)).toEqual(
      expect.arrayContaining(["AUTH", "PBSZ", "PROT", "USER", "PASS", "TYPE", "PASV", "RETR"]),
    );
    for (const command of stub.commands) {
      if (["USER", "PASS", "RETR", "PASV"].includes(command.verb)) {
        expect(command.secure).toBe(true);
      }
    }
    expect(stub.dataChannelSecure).toBe(true);
  });

  it("rejects an untrusted server certificate before any credentials are sent", async () => {
    const stub = await startStub({ tls: FIXTURE, files: { "x.csv": Buffer.from("rows") } });
    const error = await downloadViaFtp(`ftp://user:pw@127.0.0.1:${stub.port}/x.csv`, {
      maxBytes: 1024,
      timeoutMs: 5000,
      allowedHost: ANY_HOST,
      allowedPorts: [stub.port],
      ftps: true,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect(verbs(stub)).not.toContain("USER");
    expect(verbs(stub)).not.toContain("PASS");
    expect(JSON.stringify(error)).not.toContain("pw");
  });

  it("authenticates a self-signed server by its pinned certificate fingerprint", async () => {
    const stub = await startStub({ tls: FIXTURE, files: { "x.csv": Buffer.from("pinned rows") } });
    const pin = new X509Certificate(FIXTURE.cert).fingerprint256;
    const bytes = await downloadViaFtp(`ftp://user:pw@127.0.0.1:${stub.port}/x.csv`, {
      maxBytes: 1024,
      timeoutMs: 5000,
      allowedHost: ANY_HOST,
      allowedPorts: [stub.port],
      ftps: true,
      tlsPinnedCertSha256: pin,
    });
    expect(Buffer.from(bytes).toString()).toBe("pinned rows");
    expect(stub.dataChannelSecure).toBe(true);
  });

  it("rejects a certificate that does not match the pin before any credentials are sent", async () => {
    const stub = await startStub({ tls: FIXTURE, files: { "x.csv": Buffer.from("rows") } });
    const error = await downloadViaFtp(`ftp://user:pw@127.0.0.1:${stub.port}/x.csv`, {
      maxBytes: 1024,
      timeoutMs: 5000,
      allowedHost: ANY_HOST,
      allowedPorts: [stub.port],
      ftps: true,
      tlsPinnedCertSha256: "00".repeat(32),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as Error).message).toMatch(/TLS handshake/);
    expect(verbs(stub)).not.toContain("USER");
    expect(JSON.stringify(error)).not.toContain("pw");
  });

  it("stays plain FTP unless ftps is requested (Newegg's certificate is self-signed)", async () => {
    const stub = await startStub({ files: { "x.csv": Buffer.from("plain rows") } });
    const bytes = await downloadViaFtp(`ftp://user:pw@127.0.0.1:${stub.port}/x.csv`, {
      maxBytes: 1024,
      timeoutMs: 5000,
      allowedHost: ANY_HOST,
      allowedPorts: [stub.port],
    });
    expect(Buffer.from(bytes).toString()).toBe("plain rows");
    expect(verbs(stub)).not.toContain("AUTH");
  });
});

describe("FTP report download notices damaged transfers (T-5668 review)", () => {
  const base = (stub: Stub) => ({
    maxBytes: 1024,
    timeoutMs: 5000,
    allowedHost: ANY_HOST,
    allowedPorts: [stub.port],
  });
  const url = (stub: Stub) => `ftp://user:pw@127.0.0.1:${stub.port}/x.csv`;

  it("wraps a failed data-channel TLS handshake in a NeweggApiError", async () => {
    const stub = await startStub({
      tls: FIXTURE,
      brokenDataTls: true,
      files: { "x.csv": Buffer.from("rows") },
    });
    const error = await downloadViaFtp(url(stub), {
      ...base(stub),
      ftps: true,
      tlsCa: FIXTURE.cert,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as Error).message).toMatch(/data channel/);
    expect(JSON.stringify(error)).not.toContain("pw");
  });

  it("rejects a transfer shorter than the SIZE the server announced (plain FTP)", async () => {
    const stub = await startStub({
      truncateTo: 4,
      files: { "x.csv": Buffer.from("0123456789") },
    });
    const error = await downloadViaFtp(url(stub), base(stub)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as Error).message).toMatch(/truncated/);
  });

  it("rejects a transfer whose SIZE already exceeds the cap, before downloading", async () => {
    const stub = await startStub({ sizeReply: 5_000_000, files: { "x.csv": Buffer.from("rows") } });
    const error = await downloadViaFtp(url(stub), base(stub)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as Error).message).toMatch(/size limit/);
    expect(verbs(stub)).not.toContain("RETR");
  });

  it("accepts a complete transfer that matches SIZE, and one from a server without SIZE", async () => {
    const withSize = await startStub({
      files: { "x.csv": Buffer.from("0123456789") },
    });
    const first = await downloadViaFtp(url(withSize), base(withSize));
    expect(Buffer.from(first).toString()).toBe("0123456789");
    expect(verbs(withSize)).toContain("SIZE");
    const without = await startStub({
      supportSize: false,
      files: { "x.csv": Buffer.from("0123456789") },
    });
    const second = await downloadViaFtp(url(without), base(without));
    expect(Buffer.from(second).toString()).toBe("0123456789");
  });

  it("treats a TLS data channel dropped without close_notify as a truncated transfer", async () => {
    const stub = await startStub({
      tls: FIXTURE,
      truncateTo: 4,
      files: { "x.csv": Buffer.from("0123456789") },
    });
    const error = await downloadViaFtp(url(stub), {
      ...base(stub),
      ftps: true,
      tlsCa: FIXTURE.cert,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as Error).message).toMatch(/truncated/);
  });

  it("refuses an FTPS transfer when the server cannot report the file size", async () => {
    const stub = await startStub({
      tls: FIXTURE,
      supportSize: false,
      files: { "x.csv": Buffer.from("0123456789") },
    });
    const error = await downloadViaFtp(url(stub), {
      ...base(stub),
      ftps: true,
      tlsCa: FIXTURE.cert,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as Error).message).toMatch(/transfer setup/);
    expect(verbs(stub)).not.toContain("RETR");
  });
});

interface Flood {
  readonly port: number;
  readonly closedByClient: Promise<void>;
  written(): number;
  stop(): void;
}

/** A server that floods the control channel and records whether the client hung up. */
async function startFlood(chunk: () => Buffer, totalBytes: number): Promise<Flood> {
  let written = 0;
  let stopped = false;
  let markClosed: () => void = () => undefined;
  const closedByClient = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => markClosed());
    const pump = (): void => {
      while (!stopped && written < totalBytes && !socket.destroyed) {
        const buffer = chunk();
        written += buffer.length;
        if (!socket.write(buffer)) {
          socket.once("drain", pump);
          return;
        }
      }
    };
    pump();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return {
    port: (server.address() as net.AddressInfo).port,
    closedByClient,
    written: () => written,
    stop: () => {
      stopped = true;
    },
  };
}

describe("FTP control channel is bounded (T-5669 / L5)", () => {
  it("rejects quickly and hangs up when a reply line never ends", async () => {
    const flood = await startFlood(() => Buffer.alloc(64 * 1024, 0x41), 10 * 1024 * 1024);
    const started = Date.now();
    const error = await downloadViaFtp(`ftp://u:p@127.0.0.1:${flood.port}/x.csv`, {
      maxBytes: 1024,
      timeoutMs: 5000,
      allowedHost: ANY_HOST,
      allowedPorts: [flood.port],
    }).catch((e: unknown) => e);
    flood.stop();
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as Error).message).toMatch(/size limit/);
    expect(Date.now() - started).toBeLessThan(2500);
    await flood.closedByClient;
    expect(flood.written()).toBeLessThan(10 * 1024 * 1024);
  });

  it("rejects a multi-line reply that never terminates", async () => {
    const line = Buffer.from(`220-${"x".repeat(60)}\r\n`);
    const flood = await startFlood(() => line, 20 * 1024 * 1024);
    const started = Date.now();
    const error = await downloadViaFtp(`ftp://u:p@127.0.0.1:${flood.port}/x.csv`, {
      maxBytes: 1024,
      timeoutMs: 5000,
      allowedHost: ANY_HOST,
      allowedPorts: [flood.port],
    }).catch((e: unknown) => e);
    flood.stop();
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as Error).message).toMatch(/size limit/);
    expect(Date.now() - started).toBeLessThan(2500);
    await flood.closedByClient;
  });

  it.each([
    ["single-line", "199 x\r\n"],
    ["completed multi-line", "199-\r\n199 \r\n"],
  ])("hangs up on a flood of unsolicited %s replies after RETR", async (_name, unit) => {
    const dataServer = net.createServer((socket) => socket.on("error", () => undefined));
    await new Promise<void>((resolve) => dataServer.listen(0, "127.0.0.1", resolve));
    const dataPort = (dataServer.address() as net.AddressInfo).port;
    let sentUnits = 0;
    let markClosed: () => void = () => undefined;
    const closedByClient = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    let timer: NodeJS.Timeout | undefined;
    const sockets = new Set<net.Socket>();
    const control = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => {
        clearInterval(timer);
        markClosed();
      });
      socket.write("220 hi\r\n");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("latin1");
        let end = buffer.indexOf("\r\n");
        while (end >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (line.startsWith("USER")) socket.write("230 in\r\n");
          else if (line.startsWith("TYPE")) socket.write("200 ok\r\n");
          else if (line.startsWith("SIZE")) socket.write("502 no\r\n");
          else if (line.startsWith("PASV")) {
            socket.write(`227 x (127,0,0,1,${dataPort >> 8},${dataPort & 255})\r\n`);
          } else if (line.startsWith("RETR")) {
            socket.write("150 go\r\n");
            const burst = unit.repeat(5000);
            timer = setInterval(() => {
              if (socket.destroyed) return;
              socket.write(burst);
              sentUnits += 5000;
            }, 5);
          }
          end = buffer.indexOf("\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          clearInterval(timer);
          for (const socket of sockets) socket.destroy();
          dataServer.close();
          control.close(() => resolve());
        }),
    );
    const controlPort = (control.address() as net.AddressInfo).port;

    const started = Date.now();
    const error = await downloadViaFtp(`ftp://u:p@127.0.0.1:${controlPort}/x.csv`, {
      maxBytes: 1000,
      timeoutMs: 4000,
      allowedHost: ANY_HOST,
      allowedPorts: [controlPort],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NeweggApiError);
    expect((error as Error).message).toMatch(/size limit/);
    expect(Date.now() - started).toBeLessThan(2500);
    await closedByClient;
    // The client stopped reading almost at once instead of buffering the flood until the timeout.
    expect(sentUnits).toBeLessThan(500_000);
  });
});
