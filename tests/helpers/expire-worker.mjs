import { openDatabase } from "../../server/database.mjs";
import { createCatalogStore } from "../../server/catalog-store.mjs";
import { createOrderExpiration } from "../../server/order-expiration.mjs";

const db = await openDatabase({ path: process.argv[2], env: {} });
const expiration = createOrderExpiration({ db, catalog: createCatalogStore(db), autoStart: false, logger: () => {},
  persistOrder: async (order, exec) => {
    const { version, ...payload } = order;
    const result = await exec.run("UPDATE orders SET payload=?,version=version+1 WHERE id=? AND version=?", [JSON.stringify(payload), order.id, version]);
    if (!result.changes) throw Error("concurrent_change");
    return payload;
  } });
process.on("message", async () => {
  try { process.send({ changed: await expiration.expireOne(process.argv[3]) }); }
  catch { process.send({ changed: false, failed: true }); }
  finally { await expiration.close(); await db.close(); process.disconnect(); }
});
process.send({ ready: true });
