/** A rule of the game was broken (shown to the player as-is). */
export class GameError extends Error {}

/** An HTTP error with a status code (shown to the client as-is). `extra` fields are added to the JSON body. */
export class HttpError extends Error {
  constructor(status, message, extra = undefined) {
    super(message);
    this.status = status;
    if (extra) this.extra = extra;
  }
}
