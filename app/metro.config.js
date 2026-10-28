// Expo's standard bundler settings, plus two things this app needs:
//
//   * .mjs files, so the key module and Crowdlock loader — written as plain
//     modules so the same files run in the phone and in the chain tests — are
//     picked up;
//   * the repository's js/ folder, so the app checks Crowdlocks and builds
//     message hashes with exactly the code the register page uses, rather
//     than a copy that could drift.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "..", "js")];
if (!config.resolver.sourceExts.includes("mjs")) config.resolver.sourceExts.push("mjs");
// The chain tests live beside the app but must never be bundled into it.
config.resolver.blockList = [/test-chain\/.*/];
module.exports = config;
