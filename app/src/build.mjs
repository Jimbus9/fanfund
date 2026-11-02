// This build's own settings: the one file that differs between builds of the
// Crowdlock app. Everything else in the app is the Crowdlock method and is the
// same for every build.
//
// This is The Kop Fund's build.

/** The Crowdlocks this build starts with. Anything else, the fan adds. */
export const STARTING_LIST = [
  "https://jimbus9.github.io/fanfund/crowdlocks/kop-fund.json",
  "https://jimbus9.github.io/fanfund/crowdlocks/kop-fund-testnet4.json",
];

/** Where the app links the counting rule: the method's published spec. */
export const COUNTING_RULE_URL = "https://github.com/Jimbus9/fanfund/blob/main/spec/counting-rule.md#the-minimum";
