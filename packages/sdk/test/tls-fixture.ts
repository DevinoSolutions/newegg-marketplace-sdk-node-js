/**
 * Test-only self-signed certificate for the FTPS stubs. Generated at run time (a throwaway
 * ECDSA P-256 key, valid for `localhost` and `127.0.0.1`), so no key material is committed.
 * Node has no certificate builder, so the X.509 structure is DER-encoded by hand.
 */
import { generateKeyPairSync, sign } from "node:crypto";

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const ECDSA_SHA256 = tlv(0x30, oid("1.2.840.10045.4.3.2"));
const NAME = tlv(0x30, tlv(0x31, tlv(0x30, oid("2.5.4.3"), tlv(0x0c, Buffer.from("localhost")))));
const VALIDITY = tlv(
  0x30,
  tlv(0x17, Buffer.from("200101000000Z")),
  tlv(0x17, Buffer.from("491231235959Z")),
);
const SAN = tlv(
  0x30,
  oid("2.5.29.17"),
  tlv(0x04, tlv(0x30, tlv(0x82, Buffer.from("localhost")), tlv(0x87, Buffer.from([127, 0, 0, 1])))),
);

export interface TlsFixture {
  /** PEM certificate: pass as the server `cert` and as the client `ca`. */
  readonly cert: string;
  /** PEM private key for the server. */
  readonly key: string;
}

export function makeTlsFixture(): TlsFixture {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const tbs = tlv(
    0x30,
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.from([1])),
    ECDSA_SHA256,
    NAME,
    VALIDITY,
    NAME,
    publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, tlv(0x30, SAN)),
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = tlv(0x30, tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), signature));
  const base64 = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
