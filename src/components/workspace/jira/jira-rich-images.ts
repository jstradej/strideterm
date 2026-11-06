import type { CallableTransport } from "../../../transport.js";

const MAX_CACHED_IMAGES = 50;
const blobs = new Map<string, Promise<Blob>>();

/** One fetch per image per session; the caller owns any object URL it makes from the Blob. */
export function loadJiraImageBlob(
  api: CallableTransport,
  connectionId: string,
  issueId: string,
  attachmentId: string,
): Promise<Blob> {
  const key = `${connectionId}:${issueId}:${attachmentId}`;
  const known = blobs.get(key);
  if (known) return known;
  if (!api.getJiraAttachmentContent) return Promise.reject(new Error("Images are not available in this client."));
  const pending = api.getJiraAttachmentContent({ connectionId, issueId, attachmentId }).then((result) => {
    if (!/^image\//i.test(result.mediaType)) throw new Error("Jira attachment is not an image.");
    return new Blob([result.bytes as BlobPart], { type: result.mediaType });
  });
  pending.catch(() => blobs.delete(key));
  blobs.set(key, pending);
  while (blobs.size > MAX_CACHED_IMAGES) blobs.delete(blobs.keys().next().value as string);
  return pending;
}

export function clearJiraImageCache(): void {
  blobs.clear();
}
