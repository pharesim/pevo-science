import { Client } from '@hiveio/dhive';
import { config } from './config.js';
import { logger, getRequestId } from './logger.js';

/**
 * Creates a dhive Client with multi-node failover.
 * dhive natively supports an array of nodes and cycles through them on failure.
 */
export const hiveClient = new Client(config.hiveApiNodes, {
  timeout: 10_000,
  failoverThreshold: 3,
});

/**
 * Non-blocking startup health check: verifies at least one Hive API node is reachable.
 * Logs a warning if all nodes fail but does not prevent startup (Hive may recover).
 */
export async function checkHiveNodes(): Promise<void> {
  try {
    const props = await hiveClient.database.getDynamicGlobalProperties();
    logger.info(
      { headBlock: props.head_block_number, node: config.hiveApiNodes[0] },
      'Hive API node reachable',
    );
  } catch (err) {
    logger.warn(
      { err, nodes: config.hiveApiNodes, reqId: getRequestId() },
      'Hive API nodes unreachable at startup — broadcasts will fail until nodes recover',
    );
  }
}
