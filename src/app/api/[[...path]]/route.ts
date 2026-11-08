import { createApi } from "../../../server/api/handler";
import { getDatabase } from "../../../server/db";
import { getServerEnv } from "../../../server/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createApi({
  database: getDatabase,
  log: true,
  streamOptions: () => getServerEnv().sse,
});
export {
  handle as GET,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
  handle as HEAD,
  handle as OPTIONS,
};
