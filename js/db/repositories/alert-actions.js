// js/db/repositories/alert-actions.js — store "alertActions"
// Audit trail of an alert: created → acknowledged → condition_cleared → resolved.

import { run, requestToPromise } from "../database.js";
import { buildAlertAction } from "../records.js";
import { oldestFirst } from "./_common.js";

const STORE = "alertActions";

export const alertActionsRepo = {
  async add(record, opts) {
    const built = buildAlertAction(record);
    await run([STORE], "readwrite", opts, async (tx, s) => requestToPromise(s.alertActions.add(built)));
    return built;
  },

  /** Actions of one alert in lifecycle order (oldest → newest). */
  async getByAlert(alertId, opts) {
    return run([STORE], "readonly", opts, async (tx, s) =>
      oldestFirst(await requestToPromise(s.alertActions.index("by_alert").getAll(alertId)))
    );
  },
};
