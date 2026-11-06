// Keeps the names Ledger's USB transport looks up by reflection.
//
// The release build shrinks and renames code with R8. Ledger's USB transport
// finds Kotlin's Continuation.resume by name at run time, so when R8 renamed
// kotlin.coroutines.Continuation the lookup failed and the app crashed as soon
// as it started looking for a Ledger over a cable. Debug builds and the
// tests don't shrink, which is why only a real release on a phone showed it.
//
// The rules sit between two markers, and a run replaces whatever is between
// them, so changing the rules later reaches a project that was prepared before.
const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const START = "# >>> withLedgerR8Rules";
const END = "# <<< withLedgerR8Rules";

const RULES = `${START}
# Kotlin reflection must find Continuation.resume (Ledger USB transport)
-keepattributes RuntimeVisibleAnnotations,Signature,InnerClasses,EnclosingMethod
-keep class kotlin.Metadata { *; }
-keep class kotlin.coroutines.ContinuationKt { *; }
-keepnames class kotlin.coroutines.Continuation
${END}
`;

function withRules(existing) {
  const s = existing.indexOf(START);
  const e = existing.indexOf(END);
  let base = existing;
  if (s !== -1 && e > s) base = existing.slice(0, s) + existing.slice(e + END.length).replace(/^\r?\n/, "");
  if (base.length && !base.endsWith("\n")) base += "\n";
  return base + RULES;
}

module.exports = function withLedgerR8Rules(config) {
  return withDangerousMod(config, ["android", async (c) => {
    const file = path.join(c.modRequest.platformProjectRoot, "app", "proguard-rules.pro");
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    fs.writeFileSync(file, withRules(existing));
    return c;
  }]);
};

module.exports.withRules = withRules;
