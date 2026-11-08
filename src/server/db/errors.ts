export class DatabaseNotReadyError extends Error {
  constructor(cause: unknown) {
    super("Database is not ready", { cause });
  }
}
