export const FREE_PHOTO_LIMIT = 5;
export const FREE_PHOTO_BYTES = 5 * 1024 * 1024;
export const FREE_PHOTO_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;

export interface FreeNoticeInput {
  title: string;
  description: string;
  pickupLocation: string;
  imagePaths: string[];
}

export function validateNoticeboardPost(input: FreeNoticeInput) {
  if (typeof input?.title !== "string" || typeof input.description !== "string" ||
      typeof input.pickupLocation !== "string" || !Array.isArray(input.imagePaths) ||
      input.imagePaths.some((path) => typeof path !== "string")) return "Check the item details and photos.";
  const title = input.title.trim();
  const description = input.description.trim();
  const pickupLocation = input.pickupLocation.trim();
  if (title.length < 5 || title.length > 100) return "Item name must be 5 to 100 characters.";
  if (description.length > 2000) return "Description can be up to 2,000 characters.";
  if (pickupLocation.length < 5 || pickupLocation.length > 500) return "Enter a pickup location of 5 to 500 characters.";
  if (!input.imagePaths.length || input.imagePaths.length > FREE_PHOTO_LIMIT) return "Add 1 to 5 photos.";
  if (new Set(input.imagePaths).size !== input.imagePaths.length) return "Remove duplicate photos.";
  return null;
}

export function getNoticeboardStatus(post: { status: string; expiresAt: string }, now: number) {
  if (post.status === "hidden") return "Moderated";
  if (post.status === "closed") return "Removed";
  return Date.parse(post.expiresAt) > now ? "Active" : "Expired";
}

export function matchesNoticeboardSearch(
  post: { title: string; description: string; pickupLocation: string | null },
  search: string,
) {
  const term = search.trim().toLowerCase();
  return [post.title, post.description, post.pickupLocation].some((part) => part?.toLowerCase().includes(term));
}

export function freeNoticePhotoHref(id: string, index: number) {
  return `/api/free-items/photo?post=${encodeURIComponent(id)}&index=${index}`;
}
