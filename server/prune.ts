/**
 * Deleting old rows a little at a time. SQLite runs each statement on the event loop, so one
 * statement deleting a million job returns holds every request and the event stream for seconds.
 */

/** the most rows one prune statement deletes */
export const PRUNE_ROWS = 2000

/** a short pause between prune statements, so requests and the event stream get their turn */
export const breather = () => new Promise<void>((resolve) => setTimeout(resolve, 5))
