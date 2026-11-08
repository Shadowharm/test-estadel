import "server-only";
import { getServerEnv } from "../config/env";
import { openDatabase, type AppDatabase } from "./connection";
import { assertCurrentSchema } from "./migrations";
import { DatabaseNotReadyError } from "./errors";

let database: AppDatabase | undefined;
export function getDatabase() {
  if (!database) {
    let candidate: AppDatabase | undefined;
    try {
      candidate = openDatabase(getServerEnv().databasePath);
      assertCurrentSchema(candidate);
      database = candidate;
    } catch (error) {
      candidate?.close();
      throw new DatabaseNotReadyError(error);
    }
  }
  return database;
}
export function closeDatabase() {
  database?.close();
  database = undefined;
}
