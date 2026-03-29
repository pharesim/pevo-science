/**
 * App identity configuration.
 *
 * These values control the on-chain namespace (parent_permlink, custom_json id,
 * json_metadata key, primary tag). Change them to run a separate instance
 * (e.g. alpha testing) that won't collide with production data.
 */

if (!process.env.NEXT_PUBLIC_APP_TAG) {
  throw new Error("NEXT_PUBLIC_APP_TAG is not set — check APP_TAG in .env");
}
if (!process.env.NEXT_PUBLIC_APP_VERSION) {
  throw new Error("NEXT_PUBLIC_APP_VERSION is not set — check APP_VERSION in .env");
}

export const APP_TAG = process.env.NEXT_PUBLIC_APP_TAG;
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION;
export const APP_ID = `${APP_TAG}/${APP_VERSION}`;
