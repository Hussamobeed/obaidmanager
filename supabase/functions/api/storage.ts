import { LIBRARY_BUCKET, supabase } from "./db.ts";

let bucketReady: Promise<void> | null = null;

/**
 * Creates the private library bucket on first use. This protects existing
 * deployments that were created before the migration used the same bucket ID
 * as the Edge Function.
 */
export function ensureLibraryBucket(): Promise<void> {
  if (!bucketReady) {
    bucketReady = (async () => {
      const { error } = await supabase.storage.createBucket(LIBRARY_BUCKET, {
        public: false,
        fileSizeLimit: "50MB",
      });

      // The storage API returns an "already exists" error when another request
      // created the bucket first. In either case, the desired bucket is ready.
      if (error && !/already exists|duplicate|exists/i.test(error.message)) {
        throw new Error(`تعذّر إنشاء حاوية المكتبة: ${error.message}`);
      }
    })();
  }
  return bucketReady;
}
