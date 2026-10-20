/**
 * Per-marketplace wire details of volume discounts (contracts §22): the Get Volume Discount
 * request/response and the `VOLUME_DISCOUNT_DATA` feed envelope. Keeping them here means the API
 * layer has no per-marketplace `if`s (ADR 0002).
 */
import type {
  NeweggMarketplace,
  NormalizedVolumeDiscountUpdate,
  VolumeDiscountTierSnapshot,
} from "../types.js";
import type { RequestSpec } from "./types.js";
import { UnsupportedMarketplaceOperationError } from "../errors/index.js";
import { asArray, asBoolean, asNumber, asString, getField, isRecord } from "../schemas/wire.js";
import {
  VOLUME_DISCOUNT_DOCUMENT_VERSION,
  VOLUME_DISCOUNT_MESSAGE_TYPE,
} from "../volume-discounts/constants.js";

export interface VolumeDiscountPlatform {
  readonly marketplace: NeweggMarketplace;
  /** URL prefix, same as the item adapters (`""`, `b2b/`, `can/`). */
  readonly prefix: string;
  /** Whether the feed WRITE is offered. Only Newegg.ca was verified live (§22.3). */
  readonly feedWriteSupported: boolean;
}

const platforms: Readonly<Record<NeweggMarketplace, VolumeDiscountPlatform>> = {
  us: { marketplace: "us", prefix: "", feedWriteSupported: false },
  b2b: { marketplace: "b2b", prefix: "b2b/", feedWriteSupported: false },
  ca: { marketplace: "ca", prefix: "can/", feedWriteSupported: true },
};

export function getVolumeDiscountPlatform(marketplace: NeweggMarketplace): VolumeDiscountPlatform {
  return platforms[marketplace];
}

/** Throws {@link UnsupportedMarketplaceOperationError} when the feed write is not offered. */
export function assertVolumeDiscountWriteSupported(platform: VolumeDiscountPlatform): void {
  if (platform.feedWriteSupported) return;
  throw new UnsupportedMarketplaceOperationError(
    `Volume-discount writes go through the VOLUME_DISCOUNT_DATA feed, which was only verified on ` +
      `Newegg.ca; the ${platform.marketplace} marketplace is not supported for writes.`,
  );
}

/** Get Volume Discount (PUT with a body; a READ, §22.1). */
export function volumeDiscountReadRequest(
  platform: VolumeDiscountPlatform,
  identifier: { neweggItemNumber?: string; sellerPartNumber?: string },
): RequestSpec {
  const body: Record<string, string> = identifier.neweggItemNumber
    ? { NeweggItemNumber: identifier.neweggItemNumber }
    : { SellerPartNumber: identifier.sellerPartNumber ?? "" };
  return {
    method: "PUT",
    path: `${platform.prefix}contentmgmt/item/volumediscount`,
    body: { OperationType: "GetVolumeDiscountRequest", RequestBody: body },
  };
}

export interface ParsedVolumeDiscount {
  neweggItemNumber?: string;
  sellerPartNumber?: string;
  tiers: VolumeDiscountTierSnapshot[];
}

/**
 * Parses Get Volume Discount. `DiscountSetting` is an array of tiers (live, Newegg.ca), or the
 * documented `{ Tier: <object | array> }` form; both are accepted. Returns `undefined` when the
 * response carries no `ItemVolumeDiscountInfo`.
 */
export function parseVolumeDiscount(json: unknown): ParsedVolumeDiscount | undefined {
  const info = getField(getField(json, "ResponseBody"), "ItemVolumeDiscountInfo");
  if (!isRecord(info)) return undefined;
  const setting = getField(info, "DiscountSetting");
  const rows = Array.isArray(setting) ? setting : asArray(getField(setting, "Tier"));
  const tiers: VolumeDiscountTierSnapshot[] = [];
  for (const row of rows) {
    const priority = asNumber(getField(row, "Priority"));
    const quantity = asNumber(getField(row, "Quantity"));
    const sellingPrice = asNumber(getField(row, "SellingPrice"));
    if (priority === undefined || quantity === undefined || sellingPrice === undefined) continue;
    tiers.push({
      priority,
      quantity,
      sellingPrice,
      freeShipping: asBoolean(getField(row, "EnableFreeShipping")) ?? false,
    });
  }
  tiers.sort((a, b) => a.priority - b.priority);
  return {
    neweggItemNumber: asString(getField(info, "NeweggItemNumber")),
    sellerPartNumber: asString(getField(info, "SellerPartNumber")),
    tiers,
  };
}

/** Money as Newegg expects it: plain 2-decimal string. */
function money(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/**
 * `VOLUME_DISCOUNT_DATA` JSON envelope for one chunk (§22.3). `VolumeActivation` is always
 * `"True"` (create/replace); the SDK never emits `"False"` (which would delete a discount).
 */
export function buildVolumeDiscountEnvelope(items: NormalizedVolumeDiscountUpdate[]): unknown {
  return {
    NeweggEnvelope: {
      Header: { DocumentVersion: VOLUME_DISCOUNT_DOCUMENT_VERSION },
      MessageType: VOLUME_DISCOUNT_MESSAGE_TYPE,
      Message: {
        VolumeDiscountList: {
          ItemVolumeDiscountInfo: items.map((item) => {
            const info: Record<string, unknown> = {};
            if (item.sellerPartNumber !== undefined) info.SellerPartNumber = item.sellerPartNumber;
            if (item.neweggItemNumber !== undefined) info.NeweggItemNumber = item.neweggItemNumber;
            info.VolumeActivation = "True";
            info.DiscountSetting = {
              Tier: item.tiers.map((tier) => ({
                Priority: String(tier.priority),
                Quantity: String(tier.quantity),
                SellingPrice: money(tier.sellingPrice),
                EnableFreeShipping: tier.freeShipping ? "1" : "0",
              })),
            };
            return info;
          }),
        },
      },
    },
  };
}
