/** Operation identifiers used in rate-limit keys and structured log fields. */
export const Operation = {
  GetItem: "inventory.getItem",
  GetMany: "inventory.getMany",
  UpdateDirect: "inventory.update",
  FeedSubmit: "feed.submit",
  FeedStatus: "feed.status",
  FeedResult: "feed.result",
  ServiceStatus: "service.status",
} as const;
