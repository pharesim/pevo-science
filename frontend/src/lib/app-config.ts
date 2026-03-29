/**
 * App identity configuration.
 *
 * These values control the on-chain namespace (parent_permlink, custom_json id,
 * json_metadata key, primary tag). Change them to run a separate instance
 * (e.g. alpha testing) that won't collide with production data.
 */

export const APP_TAG = process.env.NEXT_PUBLIC_APP_TAG || "pevo";
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "0.1";
export const APP_ID = `${APP_TAG}/${APP_VERSION}`;
