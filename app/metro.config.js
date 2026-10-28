// Expo's standard bundler settings, plus .mjs so the key module (written as a
// plain module, so the same file runs in the phone and in the chain tests) is
// picked up.
const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
if (!config.resolver.sourceExts.includes("mjs")) config.resolver.sourceExts.push("mjs");
// The chain tests live beside the app but must never be bundled into it.
config.resolver.blockList = [/test-chain\/.*/];
module.exports = config;
