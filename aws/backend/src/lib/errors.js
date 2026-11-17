/** A rule of the game was broken (shown to the player as-is). */
export class GameError extends Error {}

/** An HTTP error with a status code (shown to the client as-is). */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
