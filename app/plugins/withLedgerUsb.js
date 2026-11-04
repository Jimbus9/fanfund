// Lets Android hand a Ledger plugged in by USB to the app, as Ledger's own
// instructions for its React Native USB transport ask: an intent filter on the
// main activity, and a filter naming Ledger's USB vendor id (11415, 0x2c97).
const { withAndroidManifest, withDangerousMod, AndroidConfig } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const FILTER = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <usb-device vendor-id="11415" />
</resources>
`;

module.exports = function withLedgerUsb(config) {
  config = withAndroidManifest(config, (c) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(c.modResults);
    const ACTION = "android.hardware.usb.action.USB_DEVICE_ATTACHED";
    activity["intent-filter"] = activity["intent-filter"] ?? [];
    if (!activity["intent-filter"].some((f) => (f.action ?? []).some((a) => a.$["android:name"] === ACTION))) {
      activity["intent-filter"].push({ action: [{ $: { "android:name": ACTION } }] });
    }
    activity["meta-data"] = activity["meta-data"] ?? [];
    if (!activity["meta-data"].some((m) => m.$["android:name"] === ACTION)) {
      activity["meta-data"].push({ $: { "android:name": ACTION, "android:resource": "@xml/usb_device_filter" } });
    }
    return c;
  });
  return withDangerousMod(config, ["android", async (c) => {
    const dir = path.join(c.modRequest.platformProjectRoot, "app/src/main/res/xml");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "usb_device_filter.xml"), FILTER);
    return c;
  }]);
};
