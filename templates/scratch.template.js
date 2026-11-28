/**
 * The scratch area's runtime, shared by the script hosts (the Suitelet host,
 * and the RESTlet host that runs RESTlet probes with a permission). A host that
 * runs a writing probe opens an area with `scratch.open()`, then:
 * - `area.sweep()` at the start of the run deletes scratch items older than
 *   the longest allowed timeout plus a margin (a run NetSuite killed never
 *   reaches its cleanup);
 * - `area.context` is what the probe gets as `context.scratch`:
 *   `{ recordType, folderId, prefix }`, with a prefix `ssv-<run id>-` that is
 *   unique to the run;
 * - `area.cleanup()` in a `finally` (or wherever the run settles) deletes
 *   every scratch record and file whose name starts with the run's prefix. It
 *   never throws and is safe to call twice; it returns `{ files, records }`
 *   (the counts it deleted) plus `error` when something could not be deleted.
 *
 * The run id is the time in milliseconds in base 36 (8 characters) followed
 * by 8 random hex digits, so the age of an item can be read from its name.
 *
 * @NApiVersion 2.1
 */
define(["N/file", "N/record", "N/search"], (file, record, search) => {
  const BASE = "ssv-";
  const MAX_AGE_SECONDS = Number("%%MAX_AGE_SECONDS%%");
  const RECORD_TYPE = "%%SCRATCH_RECORD%%";
  const MARKER_PATH = "%%SCRATCH_MARKER%%";
  /** The age is in the item's name: `ssv-<8 base-36 characters of the time><8 hex digits>-`. */
  const NAME = /^ssv-([0-9a-z]{8})[0-9a-f]{8}-/;
  /** A scratch search returns at most this many items per pass; a pass repeats while it finds some. */
  const PASSES = 5;

  const runId = (now) =>
    `${now.toString(36).padStart(8, "0")}${Math.random()
      .toString(16)
      .slice(2)
      .padEnd(8, "0")
      .slice(0, 8)}`;

  /** The ids of the items of `type` (a record type or `file`) whose names start with `start`, that `keep` does not spare. */
  const find = (type, filters, keep) => {
    const found = [];
    search
      .create({ columns: ["name"], filters, type })
      .run()
      .each((row) => {
        const name = String(row.getValue({ name: "name" }));
        if (!keep(name)) found.push(row.id);
        return true;
      });
    return found;
  };

  /** Deletes what `filters` and `keep` select, in passes; returns how many it deleted. */
  const remove = (type, filters, keep, errors) => {
    let deleted = 0;
    for (let pass = 0; pass < PASSES; pass++) {
      const ids = find(type, filters, keep);
      if (ids.length === 0) break;
      let progress = 0;
      for (const id of ids) {
        try {
          if (type === "file") file.delete({ id });
          else record.delete({ id, type });
          progress++;
        } catch (e) {
          errors.push(`${type} ${id}: ${e?.name}: ${e?.message}`);
        }
      }
      deleted += progress;
      if (progress === 0) break;
    }
    return deleted;
  };

  /** The scratch folder's id: the folder of the marker file the deploy put in it. */
  const folderOf = () => file.load({ id: MARKER_PATH }).folder;

  const open = () => {
    const now = Date.now();
    const prefix = `${BASE}${runId(now)}-`;
    const folderId = folderOf();
    const context = Object.freeze({
      folderId,
      prefix,
      recordType: RECORD_TYPE,
    });
    const filters = (start) => [["name", "startswith", start]];
    const inFolder = (start) => [
      ["folder", "anyof", [String(folderId)]],
      "AND",
      ["name", "startswith", start],
    ];
    /** Whether a sweep spares an item: one not named like a run's (so not ours to judge), or not yet old enough. */
    const spared = (name) => {
      const match = NAME.exec(name);
      if (match === null) return true;
      return now - parseInt(match[1], 36) <= MAX_AGE_SECONDS * 1000;
    };
    let finished;
    return {
      /** Deletes the run's items, then returns what it did. Never throws; a second call returns the first call's report. */
      cleanup() {
        if (finished) return finished;
        const errors = [];
        let records = 0;
        let files = 0;
        try {
          records = remove(RECORD_TYPE, filters(prefix), () => false, errors);
          files = remove("file", inFolder(prefix), () => false, errors);
        } catch (e) {
          errors.push(`${e?.name}: ${e?.message}`);
        }
        finished =
          errors.length === 0
            ? { files, records }
            : { error: errors.join("; "), files, records };
        return finished;
      },
      context,
      /** Deletes scratch items older than the longest timeout plus the margin. Never throws; returns what it deleted. */
      sweep() {
        const errors = [];
        let records = 0;
        let files = 0;
        try {
          records = remove(RECORD_TYPE, filters(BASE), spared, errors);
          files = remove("file", inFolder(BASE), spared, errors);
        } catch (e) {
          errors.push(`${e?.name}: ${e?.message}`);
        }
        return errors.length === 0
          ? { files, records }
          : { error: errors.join("; "), files, records };
      },
    };
  };

  return { open };
});
