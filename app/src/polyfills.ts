// Run before anything else. The bitcoin libraries expect two things a phone's
// JavaScript engine does not provide by itself:
//
//   Buffer                  — a byte-array helper from Node.js
//   crypto.getRandomValues  — the secure random source new backup words come
//                             from. Supplied by expo-crypto, which reads the
//                             phone's own system random generator.
import { Buffer } from "buffer";
import * as ExpoCrypto from "expo-crypto";

const g = globalThis as any;
if (!g.Buffer) g.Buffer = Buffer;
if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) {
  g.crypto.getRandomValues = (array: Uint8Array) => ExpoCrypto.getRandomValues(array);
}
