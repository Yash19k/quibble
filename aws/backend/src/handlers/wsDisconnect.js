// WebSocket $disconnect: forget the socket and mark the player offline if it was their last tab.
import { disconnect } from '../lib/game.js';
import { log } from '../lib/log.js';

export const handler = async (event) => {
  try {
    await disconnect(event.requestContext.connectionId);
  } catch (err) {
    log('error', 'disconnect failed', { error: err, connectionId: event.requestContext.connectionId });
  }
  return { statusCode: 200 };
};
